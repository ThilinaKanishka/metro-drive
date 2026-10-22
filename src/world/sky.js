import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Physically based sky: three's Preetham/Hosek-style `Sky` (atmospheric
 * scattering, sun disc, sunrise / sunset colours and animated clouds), plus a
 * star field and a moon that fade in at night. Everything follows the camera.
 *
 * `params` holds the atmosphere settings; DayNight / Weather write them and
 * ReflectionEnvironment copies them into its own Sky for the env map.
 */
export class SkySystem {
  constructor(scene, radius) {
    this.group = new THREE.Group();
    this.group.name = 'sky';
    this.sky = new Sky();
    this.sky.scale.setScalar(radius);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -2;
    this.uniforms = this.sky.material.uniforms;
    Object.assign(this.params = {}, {
      turbidity: 2.4, rayleigh: 1.1, mieCoefficient: 0.004, mieDirectionalG: 0.82,
      cloudCoverage: 0.35, cloudDensity: 0.45, cloudScale: 0.0002, cloudSpeed: 0.00004, cloudElevation: 0.55,
    });
    this.group.add(this.sky);

    // Stars: points on the upper hemisphere, screen-sized.
    const n = 1600;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2;
      const y = Math.pow(Math.random(), 0.7) * 0.98 + 0.02;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(u) * r * radius * 0.9, y * radius * 0.9, Math.sin(u) * r * radius * 0.9], i * 3);
      const b = 0.5 + Math.random() * 0.8;
      const warm = Math.random();
      col.set([b, b * (0.9 + warm * 0.1), b * (1.1 - warm * 0.2)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    this.group.add(this.stars);

    // Moon: a soft disc sprite.
    this.moonMat = new THREE.SpriteMaterial({
      map: makeMoonTexture(), transparent: true, opacity: 0, depthWrite: false, fog: false, color: 0xdfe6ff,
    });
    this.moon = new THREE.Sprite(this.moonMat);
    this.moon.scale.setScalar(radius * 0.06);
    this.moon.renderOrder = -1;
    this.group.add(this.moon);
    this.radius = radius;
    scene.add(this.group);
  }

  /** sunDir: normalised; night 0..1; time in seconds (cloud drift). */
  update(sunDir, night, time, cameraPos) {
    const u = this.uniforms;
    u.sunPosition.value.copy(sunDir);
    for (const k in this.params) u[k].value = this.params[k];
    u.time.value = time;
    const clear = 1 - Math.min(1, Math.max(0, (this.params.cloudCoverage - 0.35) * 1.6));
    this.starMat.opacity = night * clear;
    this.moonMat.opacity = night * (0.35 + clear * 0.65);
    this.moon.position.copy(sunDir).negate().multiplyScalar(this.radius * 0.85);
    if (this.moon.position.y < this.radius * 0.1) this.moon.position.y = this.radius * 0.1;
    this.group.position.copy(cameraPos);
  }

  /** Copy the current atmosphere into another Sky (env map rendering). */
  copyTo(sky) {
    const s = this.uniforms;
    const d = sky.material.uniforms;
    for (const k in d) {
      if (s[k].value?.copy) d[k].value.copy(s[k].value);
      else d[k].value = s[k].value;
    }
  }
}

function makeMoonTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.32, 'rgba(255,255,255,1)');
  g.addColorStop(0.36, 'rgba(200,210,255,0.35)');
  g.addColorStop(1, 'rgba(160,180,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // A few darker "maria".
  ctx.fillStyle = 'rgba(150,160,190,0.35)';
  for (const [x, y, r] of [[0.44, 0.42, 0.06], [0.56, 0.52, 0.05], [0.47, 0.58, 0.035]]) {
    ctx.beginPath();
    ctx.arc(x * size, y * size, r * size, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
