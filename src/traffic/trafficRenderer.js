import * as THREE from 'three';
import { getVehicleShape, getProceduralShape, getUnitGeometries, VEHICLE_TYPES } from '../vehicle/vehicleShapes.js';

const SECONDARY_COLOR = { taxi: 0xfff3c4, truck: 0xe8e8e4 };

/**
 * Draws every AI vehicle (moving and parked, all body types) with:
 *  - four BatchedMeshes (clear-coat paint + secondary, glass, vertex-coloured
 *    trim, chrome): one draw call per material for every vehicle shape, with
 *    per-object frustum culling (camera and shadow camera)
 *  - InstancedMeshes for tyres, rims, lamps and night-time headlight pools
 *
 * LOD: glTF-based vehicles switch to their low-poly procedural shape beyond
 * `lodDistance` (BatchedMesh.setGeometryIdAt), bodies beyond the draw
 * distance are hidden, and wheels / lamps / light pools are only written for
 * vehicles within `detailDistance` of the camera.
 */
export class TrafficRenderer {
  constructor(scene, traffic, maxMoving = 90) {
    this.traffic = traffic;
    this.drawDistance = 330;
    this.detailDistance = 150;
    this.lodDistance = 90;
    this.time = 0;
    const capacity = traffic.parked.length + maxMoving;
    this.capacity = capacity;

    // Every shape (and the procedural LOD of model shapes) is stored once.
    const shapes = [];
    for (const t of VEHICLE_TYPES) {
      const sh = getVehicleShape(t);
      shapes.push(sh);
      if (sh.lod) shapes.push(getProceduralShape(sh.lod));
    }
    const verts = (g) => (g ? g.getAttribute('position').count : 0);
    const count = { paint: 0, glass: 0, trim: 0, chrome: 0 };
    for (const sh of shapes) {
      count.paint += verts(sh.geo.paint) + verts(sh.geo.secondary);
      count.glass += verts(sh.geo.glass);
      count.trim += verts(sh.geo.trim);
      count.chrome += verts(sh.geo.chrome);
    }

    const mats = {
      paint: new THREE.MeshPhysicalMaterial({ roughness: 0.42, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.08 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1218, roughness: 0.04, metalness: 0.2, envMapIntensity: 1.4 }),
      trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.15, metalness: 1 }),
    };
    this.paint = new THREE.BatchedMesh(capacity * 2, count.paint, undefined, mats.paint);
    this.glass = new THREE.BatchedMesh(capacity, count.glass, undefined, mats.glass);
    this.trim = new THREE.BatchedMesh(capacity, count.trim, undefined, mats.trim);
    this.chrome = new THREE.BatchedMesh(capacity, Math.max(count.chrome, 3), undefined, mats.chrome);
    this.materials = mats;
    this.geoIds = {};
    for (const sh of shapes) {
      if (this.geoIds[sh.type]) continue;
      this.geoIds[sh.type] = {
        paint: this.paint.addGeometry(sh.geo.paint),
        sec: sh.geo.secondary ? this.paint.addGeometry(sh.geo.secondary) : -1,
        glass: this.glass.addGeometry(sh.geo.glass),
        trim: this.trim.addGeometry(sh.geo.trim),
        chrome: sh.geo.chrome ? this.chrome.addGeometry(sh.geo.chrome) : -1,
      };
    }
    for (const b of [this.paint, this.glass, this.trim, this.chrome]) {
      b.sortObjects = false; // opaque: sorting costs more CPU than it saves
      b.castShadow = true;
      b.receiveShadow = true;
      scene.add(b);
    }

    // Detail meshes (rewritten every frame, counts vary).
    const u = getUnitGeometries();
    this.tyres = new THREE.InstancedMesh(u.wheel, new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 }), capacity * 4);
    this.rims = new THREE.InstancedMesh(u.rim, mats.chrome, capacity * 4);
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
    for (const m of [this.tyres, this.rims, this.lamps, this.pools]) {
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
    this._flip = new THREE.Matrix4().makeRotationY(Math.PI);
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
      chrome: g.chrome >= 0 ? this.chrome.addInstance(g.chrome) : -1,
      visible: true,
      far: false,
      near: g,
      lod: v.shape.lod ? this.geoIds[`proc:${v.shape.lod}`] : null,
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
    if (r.chrome >= 0) this.chrome.deleteInstance(r.chrome);
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
    if (r.chrome >= 0) this.chrome.setMatrixAt(r.chrome, m);
  }

  _setVisible(v, visible) {
    const r = v.render;
    if (r.visible === visible) return;
    r.visible = visible;
    this.paint.setVisibleAt(r.paint, visible);
    if (r.sec >= 0) this.paint.setVisibleAt(r.sec, visible);
    this.glass.setVisibleAt(r.glass, visible);
    this.trim.setVisibleAt(r.trim, visible);
    if (r.chrome >= 0) this.chrome.setVisibleAt(r.chrome, visible && !r.far);
  }

  /** Swap a model vehicle between its detailed and low-poly geometry. */
  _setLod(v, far) {
    const r = v.render;
    if (!r.lod || r.far === far) return;
    r.far = far;
    const g = far ? r.lod : r.near;
    this.paint.setGeometryIdAt(r.paint, g.paint);
    this.glass.setGeometryIdAt(r.glass, g.glass);
    this.trim.setGeometryIdAt(r.trim, g.trim);
    if (r.chrome >= 0) this.chrome.setVisibleAt(r.chrome, !far && r.visible);
  }

  /** night: 0..1, eye: camera position (for distance culling / LOD). */
  update(night, eye, dt = 0) {
    this.time += dt;
    const draw2 = this.drawDistance * this.drawDistance;
    const detail2 = this.detailDistance * this.detailDistance;
    const lod2 = this.lodDistance * this.lodDistance;
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
        this._setLod(v, d2 > lod2);
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
    this.rims.count = this._tyreCount;
    this.lamps.count = this._lampCount;
    this.pools.count = pools;
    this.tyres.instanceMatrix.needsUpdate = true;
    this.rims.instanceMatrix.needsUpdate = true;
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
    const s = v.render.far ? getProceduralShape(v.shape.lod) : v.shape;
    const r = s.wheelRadius;
    for (const [wx, wz] of s.wheels) {
      local.makeRotationX(v.wheelSpin).scale(this._s.set(s.wheelWidth, r, r));
      // Right-hand wheels face outward the other way.
      if (wx < 0) local.premultiply(this._flip);
      local.setPosition(wx, r, wz);
      out.multiplyMatrices(car, local);
      this.tyres.setMatrixAt(this._tyreCount, out);
      this.rims.setMatrixAt(this._tyreCount++, out);
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
