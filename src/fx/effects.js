import * as THREE from 'three';
import { Particles } from './particles.js';

/**
 * Driving effects for the player car plus rain splashes:
 *  - tyre smoke from the rear wheels while sliding
 *  - exhaust puffs from the tailpipe, more under throttle
 *  - sparks at the contact point on hard collisions
 *  - dust when driving on park grass
 *  - rain splashes: small expanding rings on the ground around the camera,
 *    animated entirely in the vertex shader (no CPU work per splash)
 */
export class Effects {
  constructor(scene, layout) {
    this.layout = layout;
    this.smoke = new Particles(scene, { max: 260, drag: 1.2 });
    this.exhaust = new Particles(scene, { max: 120, drag: 1.5 });
    this.sparks = new Particles(scene, { max: 160, additive: true, gravity: 9.8, drag: 0.3, renderOrder: 4 });
    this.dust = new Particles(scene, { max: 160, drag: 1.4 });
    this._acc = { smoke: 0, exhaust: 0, dust: 0 };
    this._buildSplashes(scene);
  }

  _buildSplashes(scene) {
    const n = 420;
    const geo = new THREE.InstancedBufferGeometry();
    const ring = new THREE.RingGeometry(0.6, 1, 16).rotateX(-Math.PI / 2);
    geo.index = ring.index;
    geo.setAttribute('position', ring.getAttribute('position'));
    const seed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) seed.set([Math.random(), Math.random(), Math.random()], i * 3);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
    geo.instanceCount = n;
    this.splashUniforms = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRain: { value: 0 } };
    this.splashes = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.splashUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime;
        uniform vec3 uCenter;
        varying float vA;
        void main() {
          float R = 22.0;
          float t = fract(uTime * (1.6 + aSeed.z) + aSeed.z * 7.0);
          // New random spot every cycle, wrapped around the camera.
          float cycle = floor(uTime * (1.6 + aSeed.z) + aSeed.z * 7.0);
          vec2 rnd = fract(aSeed.xy + vec2(cycle * 0.618, cycle * 0.382));
          vec2 p = uCenter.xz + (rnd - 0.5) * 2.0 * R;
          float s = 0.04 + t * 0.22;
          vA = (1.0 - t) * (1.0 - smoothstep(R * 0.6, R, length(p - uCenter.xz)));
          vec3 wp = vec3(p.x, 0.03, p.y) + position * s;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uRain;
        varying float vA;
        void main() { gl_FragColor = vec4(vec3(0.8, 0.85, 0.9), vA * uRain * 0.45); }`,
    }));
    this.splashes.frustumCulled = false;
    this.splashes.renderOrder = 4;
    this.splashes.visible = false;
    scene.add(this.splashes);
  }

  /** A collision: burst of sparks at (x, z), strength = impact speed (m/s). */
  impact(x, z, strength, nx = 0, nz = 0) {
    const n = Math.min(Math.floor(strength * 2.5), 40);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * strength * 0.5;
      this.sparks.emit(
        x, 0.5 + Math.random() * 0.4, z,
        Math.cos(a) * sp + nx * 3, 1.5 + Math.random() * 3.5, Math.sin(a) * sp + nz * 3,
        0.35 + Math.random() * 0.35, 0.12, 0.04, 1.0,
        3.0, 1.4 + Math.random() * 0.6, 0.35,
      );
    }
  }

  _onGrass(x, z) {
    const L = this.layout;
    const { ix, iz } = L.blockCoords(x, z);
    const b = L.blocks[iz * L.cfg.blocksX + ix];
    if (!b?.park) return false;
    const inner = L.cfg.blockSize / 2 - L.cfg.sidewalkWidth;
    return Math.abs(x - b.cx) < inner && Math.abs(z - b.cz) < inner;
  }

  /** Per frame: car = player Car, rain 0..1, time (s). */
  update(dt, car, rain, eye, viewportHeight) {
    const p = car.physics;
    const shape = car.shape;
    if (dt > 0) {
      const s = Math.sin(p.heading);
      const c = Math.cos(p.heading);
      const back = -shape.length / 2;
      // World position of a point in car space (x = left, z = forward).
      const at = (lx, lz) => [p.x + s * lz + c * lx, p.z + c * lz - s * lx];
      // Tyre smoke: rear wheels while sliding (less on a wet road).
      if (p.skid > 0.45 && p.speed > 3) {
        this._acc.smoke += dt * p.skid * 70 * (1 - rain * 0.6);
        while (this._acc.smoke >= 1) {
          this._acc.smoke -= 1;
          for (const side of [1, -1]) {
            const [x, z] = at(side * shape.width * 0.42, -shape.length * 0.3);
            this.smoke.emit(x, 0.25, z, (Math.random() - 0.5) * 1.5 - p.vx * 0.1, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 1.5 - p.vz * 0.1,
              1.6 + Math.random(), 0.5, 3.2, 0.4, 0.82, 0.82, 0.84);
          }
        }
      }
      // Exhaust: a faint puff stream, thicker under throttle.
      this._acc.exhaust += dt * (4 + p.throttle * 22);
      while (this._acc.exhaust >= 1) {
        this._acc.exhaust -= 1;
        const [x, z] = at(shape.width * 0.28, back - 0.05);
        this.exhaust.emit(x, 0.32, z, -s * 1.2 - p.vx * 0.2 + (Math.random() - 0.5) * 0.3, 0.3, -c * 1.2 - p.vz * 0.2 + (Math.random() - 0.5) * 0.3,
          0.7 + Math.random() * 0.4, 0.12, 0.8, 0.12 + p.throttle * 0.1, 0.55, 0.56, 0.58);
      }
      // Dust on grass.
      if (p.speed > 3 && this._onGrass(p.x, p.z)) {
        this._acc.dust += dt * Math.min(p.speed, 20) * 2.5;
        while (this._acc.dust >= 1) {
          this._acc.dust -= 1;
          const side = Math.random() < 0.5 ? 1 : -1;
          const [x, z] = at(side * shape.width * 0.45, -shape.length * 0.3);
          this.dust.emit(x, 0.2, z, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2,
            1.2 + Math.random() * 0.8, 0.4, 2.4, 0.45, 0.55, 0.47, 0.34);
        }
      }
    }
    for (const sys of [this.smoke, this.exhaust, this.sparks, this.dust]) sys.update(dt, viewportHeight);

    this.splashes.visible = rain > 0.02;
    if (this.splashes.visible) {
      this.splashUniforms.uTime.value += dt;
      this.splashUniforms.uCenter.value.copy(eye);
      this.splashUniforms.uRain.value = rain;
    }
  }
}
