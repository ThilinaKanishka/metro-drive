import * as THREE from 'three';
import { clamp } from '../core/utils.js';

const MAX_SMOKE = 70;
const MAX_DENT = 0.28;        // metres a vertex can be pushed in

/**
 * Crash damage for the player car:
 *  - heavy impacts add to `level` (0..1) and dent the paint geometry around
 *    the contact point (vertices pushed towards the car's centre, with a
 *    position-hashed wobble so coincident vertices stay welded)
 *  - from ~45% the engine smokes (a pooled point-sprite system, one draw call)
 *  - the engine loses power as damage grows (see CarPhysics.powerScale)
 * repair() restores the original geometry.
 */
export class Damage {
  constructor(scene) {
    this.level = 0;
    this.model = null;
    this._buildSmoke(scene);
  }

  /** Bind to a (new) car model: keep a copy of the undamaged vertex positions. */
  attach(model) {
    this.model = model;
    const pos = model.paint.geometry.getAttribute('position');
    this.original = pos.array.slice();
    this.offset = new Float32Array(pos.count);
    this.level = 0;
  }

  /**
   * impact: normal speed of the collision (m/s); (lx, lz): contact point in
   * car-local space (x = left, z = forward).
   */
  hit(impact, lx, lz) {
    if (impact < 4.5 || !this.model) return 0;
    const severity = clamp((impact - 4.5) / 12, 0, 1);
    const add = (impact - 4.5) * 0.035;
    this.level = Math.min(1, this.level + add);
    this._dent(lx, lz, severity);
    return add;
  }

  _dent(lx, lz, severity) {
    const geo = this.model.paint.geometry;
    const pos = geo.getAttribute('position');
    const a = pos.array;
    const o = this.original;
    const R = 0.9 + severity * 0.5;
    const depth = 0.06 + severity * 0.16;
    for (let i = 0; i < pos.count; i++) {
      const x = o[i * 3];
      const y = o[i * 3 + 1];
      const z = o[i * 3 + 2];
      const dx = x - lx;
      const dz = z - lz;
      const dy = (y - 0.65) * 0.6;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= R) continue;
      const k = (1 - d / R) ** 2;
      // Wobble from a hash of the original position (welded seams stay welded).
      const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
      const wobble = 0.75 + (h - Math.floor(h)) * 0.5;
      const prev = this.offset[i];
      const next = Math.min(MAX_DENT, prev + depth * k * wobble);
      const push = next - prev;
      this.offset[i] = next;
      // Inward toward the car's centre line, slightly down.
      const cx = a[i * 3];
      const cz = a[i * 3 + 2];
      const l = Math.hypot(cx, cz * 0.5) || 1;
      a[i * 3] -= (cx / l) * push;
      a[i * 3 + 1] -= push * 0.25;
      a[i * 3 + 2] -= ((cz * 0.5) / l) * push;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  repair() {
    this.level = 0;
    if (!this.model) return;
    const geo = this.model.paint.geometry;
    const pos = geo.getAttribute('position');
    pos.array.set(this.original);
    this.offset.fill(0);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** Engine power multiplier for the physics. */
  get powerScale() {
    return 1 - this.level * 0.4;
  }

  // ------------------------------------------------------------------ smoke
  _buildSmoke(scene) {
    const geo = new THREE.BufferGeometry();
    this.sPos = new Float32Array(MAX_SMOKE * 3);
    this.sSize = new Float32Array(MAX_SMOKE);
    this.sAlpha = new Float32Array(MAX_SMOKE);
    this.sVel = new Float32Array(MAX_SMOKE * 3);
    this.sLife = new Float32Array(MAX_SMOKE);
    geo.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sSize, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.sAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0x2a2a2a) }, scale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        uniform float scale;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.2, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(color, a);
        }`,
    });
    this.smoke = new THREE.Points(geo, this.smokeMat);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 3;
    scene.add(this.smoke);
    this.emit = 0;
    this.next = 0;
  }

  /** Per frame: emit from the bonnet of the car (world pose from the model root). */
  update(dt, car, viewportHeight) {
    if (dt <= 0) return;
    this.smokeMat.uniforms.scale.value = viewportHeight * 0.5;
    const p = car.physics;
    const shape = car.shape;
    if (this.level > 0.45) {
      this.emit += dt * (this.level - 0.35) * 45;
      const s = Math.sin(p.heading);
      const c = Math.cos(p.heading);
      const fwd = shape.length / 2 - 0.8;
      this.smokeMat.uniforms.color.value.setScalar(this.level > 0.8 ? 0.12 : 0.35);
      while (this.emit >= 1) {
        this.emit -= 1;
        const k = this.next;
        this.next = (this.next + 1) % MAX_SMOKE;
        this.sPos[k * 3] = p.x + s * fwd + (Math.random() - 0.5) * 0.5;
        this.sPos[k * 3 + 1] = shape.height * 0.7;
        this.sPos[k * 3 + 2] = p.z + c * fwd + (Math.random() - 0.5) * 0.5;
        this.sVel[k * 3] = p.vx * 0.3 + (Math.random() - 0.5) * 0.6;
        this.sVel[k * 3 + 1] = 1.1 + Math.random() * 0.8;
        this.sVel[k * 3 + 2] = p.vz * 0.3 + (Math.random() - 0.5) * 0.6;
        this.sLife[k] = 1;
      }
    }
    for (let k = 0; k < MAX_SMOKE; k++) {
      if (this.sLife[k] <= 0) {
        this.sAlpha[k] = 0;
        continue;
      }
      this.sLife[k] -= dt / 2.2;
      const life = Math.max(this.sLife[k], 0);
      this.sPos[k * 3] += this.sVel[k * 3] * dt;
      this.sPos[k * 3 + 1] += this.sVel[k * 3 + 1] * dt;
      this.sPos[k * 3 + 2] += this.sVel[k * 3 + 2] * dt;
      this.sVel[k * 3] *= 1 - dt * 1.2;
      this.sVel[k * 3 + 2] *= 1 - dt * 1.2;
      this.sSize[k] = 0.6 + (1 - life) * 2.4;
      this.sAlpha[k] = life * 0.55;
    }
    const g = this.smoke.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }
}
