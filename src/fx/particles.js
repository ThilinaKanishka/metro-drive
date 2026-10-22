import * as THREE from 'three';

/**
 * Pooled point-sprite particles: one draw call per system. Each particle has
 * position, velocity, life, start / end size, colour and peak alpha; the
 * CPU integrates (gravity, drag) and the shader draws a soft disc.
 * Use additive blending for glowing things (sparks), normal for smoke / dust.
 */
export class Particles {
  constructor(scene, { max = 300, additive = false, gravity = 0, drag = 0.8, renderOrder = 3 } = {}) {
    this.max = max;
    this.gravity = gravity;
    this.drag = drag;
    this.next = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);      // 1 -> 0
    this.rate = new Float32Array(max);      // life lost per second
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        uniform float scale;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = alpha;
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.15, d) * vAlpha;
          if (a < 0.005) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    scene.add(this.points);
    this.active = 0;
  }

  /** Spawn one particle. */
  emit(x, y, z, vx, vy, vz, life, size0, size1, alpha, r, g, b) {
    const k = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([x, y, z], k * 3);
    this.vel.set([vx, vy, vz], k * 3);
    this.life[k] = 1;
    this.rate[k] = 1 / life;
    this.size0[k] = size0;
    this.size1[k] = size1;
    this.alpha0[k] = alpha;
    this.color.set([r, g, b], k * 3);
    this.active = this.max;
  }

  update(dt, viewportHeight) {
    this.material.uniforms.scale.value = viewportHeight * 0.5;
    if (!this.active || dt <= 0) return;
    const drag = Math.max(0, 1 - this.drag * dt);
    let alive = 0;
    for (let k = 0; k < this.max; k++) {
      if (this.life[k] <= 0) {
        this.alpha[k] = 0;
        continue;
      }
      alive++;
      this.life[k] -= this.rate[k] * dt;
      const l = Math.max(this.life[k], 0);
      const i = k * 3;
      this.vel[i + 1] -= this.gravity * dt;
      this.vel[i] *= drag;
      this.vel[i + 2] *= drag;
      this.pos[i] += this.vel[i] * dt;
      this.pos[i + 1] = Math.max(this.pos[i + 1] + this.vel[i + 1] * dt, 0.02);
      this.pos[i + 2] += this.vel[i + 2] * dt;
      this.size[k] = this.size1[k] + (this.size0[k] - this.size1[k]) * l;
      // Fade in quickly, out slowly.
      this.alpha[k] = this.alpha0[k] * Math.min(1, (1 - l) * 8) * l;
    }
    if (!alive) this.active = 0;
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.size.needsUpdate = a.alpha.needsUpdate = a.color.needsUpdate = true;
  }
}
