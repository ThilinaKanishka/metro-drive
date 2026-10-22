import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { worldUniforms } from './shared.js';
import { smoothstep, lerp } from '../core/utils.js';

/**
 * Day/night cycle: moves the sun (or moon) light, recolours sky, fog and
 * ambient light, and publishes `night` (0..1) to everything else.
 * time: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 */
export class DayNight {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = CONFIG.dayNight.startTime;
    this.autoCycle = CONFIG.dayNight.autoCycle;
    this.night = 0;
    this.transition = null;

    // Key light (sun by day, moon by night). One shadow-casting light total.
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = CONFIG.render.shadows;
    const sh = this.sun.shadow;
    const a = CONFIG.render.shadowArea;
    sh.mapSize.set(CONFIG.render.shadowMapSize, CONFIG.render.shadowMapSize);
    sh.camera.left = -a;
    sh.camera.right = a;
    sh.camera.top = a;
    sh.camera.bottom = -a;
    sh.camera.near = 1;
    sh.camera.far = 400;
    sh.bias = -0.0004;
    sh.normalBias = 0.03;
    sh.radius = CONFIG.render.shadowRadius;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a5444, 1.0);
    scene.add(this.hemi);

    this.sky = this._createSky();
    scene.add(this.sky);

    this._sunDir = new THREE.Vector3();
    this._moonDir = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._snap = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._top = new THREE.Color();
    this._horizon = new THREE.Color();
    this._tmp = new THREE.Color();
  }

  _createSky() {
    const geo = new THREE.SphereGeometry(CONFIG.render.cameraFar * 0.9, 32, 16);
    this.skyUniforms = {
      topColor: { value: new THREE.Color(0x4f8fd8) },
      horizonColor: { value: new THREE.Color(0xbfd8ee) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      night: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 sunDir;
        uniform float night;
        varying vec3 vDir;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        void main() {
          float h = max(vDir.y, 0.0);
          vec3 col = mix(horizonColor, topColor, pow(h, 0.55));
          // Sun disc + glow (moon at night uses the opposite direction).
          vec3 sd = night > 0.5 ? -sunDir : sunDir;
          float d = max(dot(normalize(vDir), normalize(sd)), 0.0);
          vec3 glowCol = night > 0.5 ? vec3(0.55, 0.62, 0.8) : vec3(1.0, 0.85, 0.6);
          col += glowCol * pow(d, 900.0) * 3.0;
          col += glowCol * pow(d, 12.0) * 0.25 * (1.0 - night * 0.6);
          // Stars.
          vec3 cell = floor(vDir * 220.0);
          float star = step(0.9975, hash(cell)) * smoothstep(0.05, 0.3, vDir.y);
          col += vec3(star) * night * 0.9;
          // Below horizon: fade to horizon colour (hidden by ground anyway).
          col = mix(horizonColor, col, smoothstep(-0.05, 0.02, vDir.y));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    return mesh;
  }

  /** Quality setting: resize the sun's shadow map (re-allocated on next render). */
  setShadowMapSize(size) {
    const sh = this.sun.shadow;
    if (sh.mapSize.x === size) return;
    sh.mapSize.set(size, size);
    sh.map?.dispose();
    sh.map = null;
  }

  _snapToTexel(p, dir) {
    const texel = (CONFIG.render.shadowArea * 2) / this.sun.shadow.mapSize.x;
    // Orthonormal basis perpendicular to the light direction.
    const u = this._u.crossVectors(this._worldUp, dir);
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
    u.normalize();
    const w = this._w.crossVectors(dir, u).normalize();
    const pu = p.dot(u);
    const pw = p.dot(w);
    return this._snap.copy(p)
      .addScaledVector(u, Math.round(pu / texel) * texel - pu)
      .addScaledVector(w, Math.round(pw / texel) * texel - pw);
  }

  /** Jump toward the opposite part of the day (N key), smoothly. */
  toggle() {
    const target = this.night > 0.5 ? 0.45 : 0.95; // morning-ish day, or late night
    let delta = target - this.time;
    if (delta < 0) delta += 1;
    this.transition = { remaining: delta, speed: delta / CONFIG.dayNight.toggleTransition };
  }

  toggleAuto() {
    this.autoCycle = !this.autoCycle;
    return this.autoCycle;
  }

  /** Called every frame. `focus` is the point the shadow camera should cover. */
  update(dt, focus, camera) {
    if (this.transition) {
      const step = Math.min(this.transition.speed * dt, this.transition.remaining);
      this.time = (this.time + step) % 1;
      this.transition.remaining -= step;
      if (this.transition.remaining <= 1e-5) this.transition = null;
    } else if (this.autoCycle) {
      this.time = (this.time + dt / CONFIG.dayNight.cycleDuration) % 1;
    }

    // Sun position: elevation follows a sine over the day, azimuth sweeps east→west.
    const phase = (this.time - 0.25) * Math.PI * 2;
    const elev = Math.sin(phase);
    const az = phase * 0.5 + 0.6;
    const ce = Math.sqrt(Math.max(0, 1 - elev * elev));
    // Keep the sun off-zenith so shadows always have some length.
    this._sunDir.set(Math.cos(az) * Math.max(ce, 0.45), elev, Math.sin(az) * Math.max(ce, 0.45)).normalize();

    this.night = 1 - smoothstep(-0.14, 0.1, elev);
    worldUniforms.uNight.value = this.night;

    // Sky palette: night → dawn/dusk → day, keyed on sun elevation.
    const dawn = 1 - smoothstep(0.0, 0.35, Math.abs(elev)); // strongest near horizon
    const day = smoothstep(-0.05, 0.3, elev);
    this._top.set(0x0a1028).lerp(this._tmp.set(0x4f8fd8), day);
    this._horizon.set(0x1a2140).lerp(this._tmp.set(0xc3d9ec), day);
    this._horizon.lerp(this._tmp.set(0xf09a5c), dawn * 0.65);
    this._top.lerp(this._tmp.set(0x5a6fa8), dawn * 0.35);

    this.skyUniforms.topColor.value.copy(this._top);
    this.skyUniforms.horizonColor.value.copy(this._horizon);
    this.skyUniforms.sunDir.value.copy(this._sunDir);
    this.skyUniforms.night.value = this.night;
    this.scene.fog.color.copy(this._horizon);
    this.scene.background.copy(this._horizon);

    // Key light: sun by day, dim blue moonlight from the opposite side at night.
    const isMoon = elev < -0.02;
    const lightDir = isMoon ? this._moonDir.copy(this._sunDir).negate() : this._sunDir;
    if (isMoon) {
      this.sun.color.set(0x8fa6d8);
      this.sun.intensity = 0.35 * smoothstep(0.02, 0.25, -elev);
    } else {
      this.sun.color.set(0xffffff).lerp(this._tmp.set(0xffb070), dawn * 0.8);
      this.sun.intensity = 2.8 * smoothstep(-0.02, 0.2, elev);
    }
    this.hemi.intensity = lerp(0.32, 1.05, day);
    this.hemi.color.copy(this._top).lerp(this._tmp.set(0xffffff), 0.4);
    this.hemi.groundColor.set(0x4a4438).lerp(this._tmp.set(0x10121a), this.night);
    this.renderer.toneMappingExposure = lerp(1.15, 1.0, day);

    // Shadow camera follows the focus point, snapped to whole shadow-map
    // texels in light space so shadow edges don't shimmer while driving.
    if (focus) {
      const snapped = this._snapToTexel(focus, lightDir);
      this.sun.target.position.copy(snapped);
      this.sun.position.copy(snapped).addScaledVector(lightDir, 150);
      this.sun.target.updateMatrixWorld();
    }
    if (camera) this.sky.position.copy(camera.position);
  }
}
