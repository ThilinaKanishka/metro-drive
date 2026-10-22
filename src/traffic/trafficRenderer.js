import * as THREE from 'three';
import { getVehicleShape, getUnitGeometries, VEHICLE_TYPES } from '../vehicle/vehicleShapes.js';

const SECONDARY_COLOR = { taxi: 0xfff3c4, truck: 0xe8e8e4 };

/**
 * Draws every AI vehicle (moving and parked, all body types) with:
 *  - three BatchedMeshes (paint + secondary, glass, trim): one draw call per
 *    material for all vehicle shapes, with per-object frustum culling
 *  - InstancedMeshes for tyres, lamps and night-time headlight pools
 *
 * LOD: bodies beyond the draw distance are hidden; wheels, lamps and light
 * pools are only written for vehicles within `detailDistance` of the camera.
 */
export class TrafficRenderer {
  constructor(scene, traffic, maxMoving = 90) {
    this.traffic = traffic;
    this.drawDistance = 330;
    this.detailDistance = 150;
    this.time = 0;
    const capacity = traffic.parked.length + maxMoving;
    this.capacity = capacity;

    // Count vertices of every shape once (geometry is stored once per type).
    const shapes = VEHICLE_TYPES.map((t) => getVehicleShape(t));
    const verts = (g) => (g ? g.getAttribute('position').count : 0);
    let vPaint = 0;
    let vGlass = 0;
    let vTrim = 0;
    for (const s of shapes) {
      vPaint += verts(s.geo.paint) + verts(s.geo.secondary);
      vGlass += verts(s.geo.glass);
      vTrim += verts(s.geo.trim);
    }

    const paintMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.12, metalness: 0.65 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 });
    this.paint = new THREE.BatchedMesh(capacity * 2, vPaint, undefined, paintMat);
    this.glass = new THREE.BatchedMesh(capacity, vGlass, undefined, glassMat);
    this.trim = new THREE.BatchedMesh(capacity, vTrim, undefined, trimMat);
    this.materials = { paint: paintMat, glass: glassMat };
    this.geoIds = {};
    for (const s of shapes) {
      this.geoIds[s.type] = {
        paint: this.paint.addGeometry(s.geo.paint),
        sec: s.geo.secondary ? this.paint.addGeometry(s.geo.secondary) : -1,
        glass: this.glass.addGeometry(s.geo.glass),
        trim: this.trim.addGeometry(s.geo.trim),
      };
    }
    for (const b of [this.paint, this.glass, this.trim]) {
      b.sortObjects = false; // opaque: sorting costs more CPU than it saves
      b.castShadow = true;
      b.receiveShadow = true;
      scene.add(b);
    }

    // Detail meshes (rewritten every frame, counts vary).
    const u = getUnitGeometries();
    this.tyres = new THREE.InstancedMesh(u.wheel, new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }), capacity * 4);
    // Lamps are unlit so their instance colour reads as brightness.
    this.lamps = new THREE.InstancedMesh(u.lamp, new THREE.MeshBasicMaterial(), capacity * 8);
    this.poolMat = new THREE.MeshBasicMaterial({
      map: makeBeamTexture(), color: 0xfff0d0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, maxMoving);
    this.pools.renderOrder = 2;
    this.lamps.setColorAt(0, new THREE.Color());
    for (const m of [this.tyres, this.lamps, this.pools]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; // instances span the whole city
      m.count = 0;
      scene.add(m);
    }
    this.tyres.castShadow = true;

    this._car = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._out = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();

    for (const v of traffic.parked) this.add(v);
    for (const v of traffic.vehicles) this.add(v);
    traffic.onSpawn = (v) => this.add(v);
    traffic.onDespawn = (v) => this.remove(v);
  }

  add(v) {
    const g = this.geoIds[v.shape.type];
    const r = {
      paint: this.paint.addInstance(g.paint),
      sec: g.sec >= 0 ? this.paint.addInstance(g.sec) : -1,
      glass: this.glass.addInstance(g.glass),
      trim: this.trim.addInstance(g.trim),
      visible: true,
    };
    this.paint.setColorAt(r.paint, this._c.set(v.color));
    if (r.sec >= 0) this.paint.setColorAt(r.sec, this._c.set(SECONDARY_COLOR[v.shape.type] ?? 0xe8e8e4));
    v.render = r;
    this._setBody(v);
  }

  remove(v) {
    const r = v.render;
    if (!r) return;
    this.paint.deleteInstance(r.paint);
    if (r.sec >= 0) this.paint.deleteInstance(r.sec);
    this.glass.deleteInstance(r.glass);
    this.trim.deleteInstance(r.trim);
    v.render = null;
  }

  _setBody(v) {
    const m = this._car;
    this._q.setFromAxisAngle(this._up, v.heading);
    m.compose(this._p.set(v.x, 0, v.z), this._q, this._s.set(1, 1, 1));
    const r = v.render;
    this.paint.setMatrixAt(r.paint, m);
    if (r.sec >= 0) this.paint.setMatrixAt(r.sec, m);
    this.glass.setMatrixAt(r.glass, m);
    this.trim.setMatrixAt(r.trim, m);
  }

  _setVisible(v, visible) {
    const r = v.render;
    if (r.visible === visible) return;
    r.visible = visible;
    this.paint.setVisibleAt(r.paint, visible);
    if (r.sec >= 0) this.paint.setVisibleAt(r.sec, visible);
    this.glass.setVisibleAt(r.glass, visible);
    this.trim.setVisibleAt(r.trim, visible);
  }

  /** night: 0..1, eye: camera position (for distance culling / LOD). */
  update(night, eye, dt = 0) {
    this.time += dt;
    const draw2 = this.drawDistance * this.drawDistance;
    const detail2 = this.detailDistance * this.detailDistance;
    this._tyreCount = 0;
    this._lampCount = 0;
    let pools = 0;
    const on = THREE.MathUtils.smoothstep(night, 0.3, 0.6);
    this._head = [0.75 + night * 1.5, 0.75 + night * 1.4, 0.7 + night * 1.1];

    const list = [this.traffic.parked, this.traffic.vehicles];
    for (let l = 0; l < 2; l++) {
      const moving = l === 1;
      for (const v of list[l]) {
        if (!v.render) continue;
        const dx = v.x - eye.x;
        const dz = v.z - eye.z;
        const d2 = dx * dx + dz * dz;
        this._setVisible(v, d2 < draw2);
        if (d2 >= draw2) continue;
        if (moving) this._setBody(v);
        else {
          this._q.setFromAxisAngle(this._up, v.heading);
          this._car.compose(this._p.set(v.x, 0, v.z), this._q, this._s.set(1, 1, 1));
        }
        if (d2 > detail2) continue;
        this._writeDetail(v, moving, night);
        if (moving && on > 0.01 && pools < this.pools.instanceMatrix.count) {
          this._local.makeScale(5, 1, 11).setPosition(0, 0.05, v.len / 2 + 6.3);
          this.pools.setMatrixAt(pools++, this._out.multiplyMatrices(this._car, this._local));
        }
      }
    }

    this.tyres.count = this._tyreCount;
    this.lamps.count = this._lampCount;
    this.pools.count = pools;
    this.tyres.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
    this.lamps.instanceColor.needsUpdate = true;
    this.pools.instanceMatrix.needsUpdate = true;
    this.poolMat.opacity = on * 0.35;
    this.pools.visible = on > 0.01;
  }

  /** Wheels + lamps for one vehicle; this._car holds its world matrix. */
  _writeDetail(v, moving, night) {
    const car = this._car;
    const local = this._local;
    const out = this._out;
    const s = v.shape;
    const r = s.wheelRadius;
    for (const [wx, wz] of s.wheels) {
      local.makeRotationX(v.wheelSpin).scale(this._s.set(s.wheelWidth, r, r)).setPosition(wx, r, wz);
      this.tyres.setMatrixAt(this._tyreCount++, out.multiplyMatrices(car, local));
    }
    const c = this._c;
    const L = s.lamps;
    const lamp = (spec, cr, cg, cb) => {
      const [x, y, z, w, h] = spec;
      local.makeScale(w, h, 1).setPosition(x, y, z);
      this.lamps.setMatrixAt(this._lampCount, out.multiplyMatrices(car, local));
      this.lamps.setColorAt(this._lampCount++, c.setRGB(cr, cg, cb));
    };
    const [hr, hg, hb] = moving ? this._head : [0.55, 0.55, 0.52];
    for (const h of L.head) lamp(h, hr, hg, hb);
    const tb = moving ? (v.braking ? 1.0 : 0.35 + night * 0.4) : 0.22;
    for (const t of L.tail) lamp(t, tb * 1.6, tb * 0.1, tb * 0.08);
    // Indicators: blink on the turning side.
    const blink = v.indicator !== 0 && ((this.time + v.blinkPhase) % 0.7) < 0.38;
    for (let side = 0; side < 2; side++) {
      const lit = blink && (side === 0 ? v.indicator < 0 : v.indicator > 0);
      const k = lit ? 2.2 : 0.22;
      lamp(L.indFront[side], k, k * 0.55, k * 0.05);
      lamp(L.indRear[side], k, k * 0.55, k * 0.05);
    }
  }
}

/**
 * Soft gradient, bright near the car and fading forward. The canvas top ends
 * up nearest the car once the plane is laid flat (rotateX(-PI/2) maps +v to -z).
 */
function makeBeamTexture() {
  const w = 64;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(w / 2, h * 0.25, 2, w / 2, h * 0.45, h * 0.55);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
