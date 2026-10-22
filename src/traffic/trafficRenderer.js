import * as THREE from 'three';
import { getVehicleShape, getUnitGeometries } from '../vehicle/vehicleShapes.js';

/**
 * Draws every AI car with a handful of InstancedMeshes (paint, glass, trim,
 * tyres, head/tail lamps, headlight pools) - ~8 draw calls for all traffic.
 */
export class TrafficRenderer {
  constructor(scene, traffic) {
    this.traffic = traffic;
    const n = traffic.cars.length;
    const shape = getVehicleShape('sedan');
    const u = getUnitGeometries();
    const g = {
      paint: shape.geo.paint, cabin: shape.geo.glass, trim: shape.geo.trim,
      wheel: u.wheel.clone().scale(shape.wheelWidth, shape.wheelRadius, shape.wheelRadius),
      headlight: u.lamp.clone().scale(0.42, 0.12, 1), taillight: u.lamp.clone().scale(0.4, 0.12, 1),
    };
    this.shape = shape;

    this.paint = new THREE.InstancedMesh(g.paint, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.25 }), n);
    this.glass = new THREE.InstancedMesh(g.cabin, new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.15, metalness: 0.6 }), n);
    this.trim = new THREE.InstancedMesh(g.trim, new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 }), n);
    this.tyres = new THREE.InstancedMesh(g.wheel, new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }), n * 4);
    // Lamps are unlit so their instance colour reads as brightness.
    this.heads = new THREE.InstancedMesh(g.headlight, new THREE.MeshBasicMaterial(), n * 2);
    this.tails = new THREE.InstancedMesh(g.taillight, new THREE.MeshBasicMaterial(), n * 2);

    // Headlight pools on the road at night.
    this.poolMat = new THREE.MeshBasicMaterial({
      map: makeBeamTexture(), color: 0xfff0d0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, n);
    this.pools.renderOrder = 2;

    const color = new THREE.Color();
    traffic.cars.forEach((car, i) => this.paint.setColorAt(i, color.set(car.color)));

    this.all = [this.paint, this.glass, this.trim, this.tyres, this.heads, this.tails, this.pools];
    for (const m of this.all) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; // instances span the whole city
      scene.add(m);
    }
    for (const m of [this.paint, this.trim, this.tyres]) m.castShadow = true;
    this.paint.receiveShadow = true;

    this._car = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._out = new THREE.Matrix4();
    this._rot = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
  }

  update(night) {
    const cars = this.traffic.cars;
    const car = this._car;
    const local = this._local;
    const out = this._out;
    const headColor = this._c.setRGB(0.75 + night * 1.5, 0.75 + night * 1.4, 0.7 + night * 1.1);
    const headR = headColor.r;
    const headG = headColor.g;
    const headB = headColor.b;
    const r = this.shape.wheelRadius;
    const WHEEL_POSITIONS = this.shape.wheels;
    const HEADLIGHT_POSITIONS = this.shape.lamps.head;
    const TAILLIGHT_POSITIONS = this.shape.lamps.tail;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      this._q.setFromAxisAngle(this._up, c.heading);
      car.compose(this._p.set(c.x, 0, c.z), this._q, this._s);
      this.paint.setMatrixAt(i, car);
      this.glass.setMatrixAt(i, car);
      this.trim.setMatrixAt(i, car);

      for (let w = 0; w < 4; w++) {
        const [wx, wz] = WHEEL_POSITIONS[w];
        local.makeRotationX(c.wheelSpin).setPosition(wx, r, wz);
        this.tyres.setMatrixAt(i * 4 + w, out.multiplyMatrices(car, local));
      }
      for (let k = 0; k < 2; k++) {
        const [hx, hy, hz] = HEADLIGHT_POSITIONS[k];
        this.heads.setMatrixAt(i * 2 + k, out.multiplyMatrices(car, local.makeTranslation(hx, hy, hz)));
        this.heads.setColorAt(i * 2 + k, this._c.setRGB(headR, headG, headB));
        const [tx, ty, tz] = TAILLIGHT_POSITIONS[k];
        this.tails.setMatrixAt(i * 2 + k, out.multiplyMatrices(car, local.makeTranslation(tx, ty, tz)));
        const b = c.braking ? 1.0 : 0.35 + night * 0.4;
        this.tails.setColorAt(i * 2 + k, this._c.setRGB(b * 1.6, b * 0.1, b * 0.08));
      }
      // Beam pool: stretched decal in front of the car.
      local.makeScale(5, 1, 11).setPosition(0, 0.05, 8.5);
      this.pools.setMatrixAt(i, out.multiplyMatrices(car, local));
    }

    for (const m of this.all) m.instanceMatrix.needsUpdate = true;
    this.heads.instanceColor.needsUpdate = true;
    this.tails.instanceColor.needsUpdate = true;

    const on = THREE.MathUtils.smoothstep(night, 0.3, 0.6);
    this.poolMat.opacity = on * 0.35;
    this.pools.visible = on > 0.01;
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
