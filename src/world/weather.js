import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { lerp, approach } from '../core/utils.js';

export const WEATHER_TYPES = ['clear', 'rain', 'fog'];

/**
 * Weather: clear / rain / fog, blended smoothly.
 *
 * Runs after the day/night system each frame and adjusts what it produced:
 * overcast sky and fog colour, fog distance, dimmer sun. Rain adds GPU-
 * animated streaks (a LineSegments whose vertex shader wraps drops around
 * the camera in world space, so they don't swim when you turn), a wet road
 * (darker, glossier asphalt that picks up the reflection env map) and less
 * tyre grip.
 */
export class Weather {
  constructor(scene, camera, roadMaterials) {
    this.scene = scene;
    this.camera = camera;
    this.cfg = CONFIG.weather;
    this.roadMats = roadMaterials;
    this.type = 'clear';
    this.rain = 0;         // 0..1 blended amounts
    this.fog = 0;
    this.wet = 0;          // road wetness lags the rain (dries slowly)
    this._buildRain(scene);
    for (const m of Object.values(roadMaterials)) {
      m.userData.dry = { color: m.color.clone(), roughness: m.roughness };
    }
    this._grey = new THREE.Color();
    this._tmp = new THREE.Color();
  }

  /** 'clear' | 'rain' | 'fog' | 'random' */
  set(type) {
    if (type === 'random') {
      const w = this.cfg.randomWeights;
      let r = Math.random() * (w.clear + w.rain + w.fog);
      type = 'clear';
      for (const t of WEATHER_TYPES) {
        r -= w[t];
        if (r <= 0) {
          type = t;
          break;
        }
      }
    }
    this.type = WEATHER_TYPES.includes(type) ? type : 'clear';
    return this.type;
  }

  /** Jump straight to the target state (on game start). */
  snap() {
    this.rain = this.type === 'rain' ? 1 : 0;
    this.fog = this.type === 'fog' ? 1 : 0;
    this.wet = this.rain;
  }

  /** Grip multiplier for the player's tyres. */
  get grip() {
    return lerp(1, this.cfg.rainGrip, this.wet);
  }

  /** Speed multiplier for AI traffic. */
  get trafficSpeed() {
    return lerp(1, this.cfg.rainTrafficSpeed, Math.max(this.rain, this.fog));
  }

  /** How much bad weather should switch headlights on (0..1). */
  get gloom() {
    return Math.max(this.rain * 0.7, this.fog * 0.8);
  }

  _buildRain(scene) {
    const n = this.cfg.rainDrops;
    const pos = new Float32Array(n * 2 * 3);
    const end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = Math.random();
      const y = Math.random();
      const z = Math.random();
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1; // second vertex = streak tail
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('tail', new THREE.BufferAttribute(end, 1));
    this.rainUniforms = {
      time: { value: 0 },
      center: { value: new THREE.Vector3() },
      radius: { value: this.cfg.rainRadius },
      opacity: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.rainUniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float tail;
        uniform float time;
        uniform vec3 center;
        uniform float radius;
        varying float vTail;
        void main() {
          float size = radius * 2.0;
          float height = 26.0;
          // World-anchored grid wrapped around the camera.
          vec3 p = position * vec3(size, height, size);
          p.x = mod(p.x - center.x, size) + center.x - radius;
          p.z = mod(p.z - center.z, size) + center.z - radius;
          float fall = 22.0;
          p.y = mod(p.y - time * fall, height) + max(center.y - 10.0, -2.0);
          // Streak: tail vertex sits above / up-wind of the head.
          p += vec3(0.35, 1.0, 0.15) * tail * 0.55;
          vTail = tail;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float opacity;
        varying float vTail;
        void main() {
          gl_FragColor = vec4(0.75, 0.8, 0.9, opacity * (1.0 - vTail * 0.7));
        }`,
    });
    this.rainMesh = new THREE.LineSegments(geo, mat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 5;
    this.rainMesh.visible = false;
    scene.add(this.rainMesh);
  }

  /**
   * Call after DayNight.update(). dayNight: the DayNight instance (its sky,
   * fog colour and lights are adjusted in place).
   */
  update(dt, dayNight) {
    const k = dt / this.cfg.transition;
    this.rain = approach(this.rain, this.type === 'rain' ? 1 : 0, k);
    this.fog = approach(this.fog, this.type === 'fog' ? 1 : 0, k);
    // Roads get wet quickly but dry slowly.
    this.wet = approach(this.wet, this.rain, this.rain > this.wet ? k * 1.5 : dt / 40);

    const overcast = Math.max(this.rain, this.fog);
    const fog = this.scene.fog;
    const night = dayNight.night;
    // Sky / fog colour: blend toward a grey that follows the light level.
    const level = lerp(0.62, 0.07, night);
    this._grey.setRGB(level, level * 1.03, level * 1.08);
    const sky = dayNight.skyUniforms;
    sky.topColor.value.lerp(this._tmp.copy(this._grey).multiplyScalar(0.85), overcast * 0.85);
    sky.horizonColor.value.lerp(this._grey, overcast * 0.9);
    fog.color.copy(sky.horizonColor.value);
    this.scene.background.copy(fog.color);
    fog.near = lerp(lerp(CONFIG.render.fogNear, this.cfg.fogNear, this.fog), CONFIG.render.fogNear * 0.6, this.rain * (1 - this.fog));
    fog.far = lerp(lerp(CONFIG.render.fogFar, this.cfg.fogFar, this.fog), this.cfg.rainFogFar, this.rain * (1 - this.fog));
    this.fogFar = fog.far;
    // Thicker, lower clouds and a hazier atmosphere in bad weather.
    const sp = dayNight.skySystem.params;
    sp.cloudCoverage = lerp(0.32, 0.95, overcast);
    sp.cloudDensity = lerp(0.45, 0.9, overcast);
    sp.turbidity = lerp(2.4, 9, overcast);
    sp.rayleigh = lerp(1.1, 0.4, overcast);
    this.overcast = overcast;
    // Clouds block the sun: softer, dimmer key light, more flat ambient.
    dayNight.sun.intensity *= 1 - overcast * 0.65;
    dayNight.hemi.intensity *= 1 - overcast * 0.15;

    // Wet road: darker and glossier, so it reflects the sky env map.
    for (const m of Object.values(this.roadMats)) {
      const dry = m.userData.dry;
      m.color.copy(dry.color).multiplyScalar(1 - this.wet * 0.35);
      m.roughness = lerp(dry.roughness, 0.4, this.wet);
      m.envMapIntensity = 0.42 + this.wet * 0.25;
    }

    // Rain streaks.
    this.rainMesh.visible = this.rain > 0.01;
    if (this.rainMesh.visible) {
      const u = this.rainUniforms;
      u.time.value += dt;
      u.center.value.copy(this.camera.position);
      u.opacity.value = this.rain * lerp(0.45, 0.3, night);
    }
  }
}
