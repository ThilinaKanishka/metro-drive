import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Image-based lighting and reflections. A small scene (a copy of the current
 * physically based sky with its clouds, a dark ground and a ring of skyline
 * boxes) is pre-filtered with PMREM into an HDR env map that becomes
 * `scene.environment`: every PBR material gets sky-coloured ambient light and
 * reflections (car paint, glass, chrome, glass towers, wet roads).
 *
 * The map is re-rendered only when the sun has moved or the weather changed
 * noticeably (a couple of ms every few seconds of the day cycle).
 *
 * Modes (quality preset):
 *  - 'full': scene.environment = env map, IBL on every PBR material
 *  - 'cars': only registered materials (car paint / glass / chrome, and the
 *    roads while they are wet) get the env map; big surfaces use the cheaper
 *    hemisphere light. Image-based lighting is costly per pixel on
 *    integrated GPUs, and cars / wet roads are where reflections matter.
 * Registered materials get the env map assigned explicitly so their
 * `envMapIntensity` takes effect (wet roads drive theirs from the weather).
 */
export class ReflectionEnvironment {
  constructor(renderer, scene, skySystem) {
    this.renderer = renderer;
    this.scene = scene;
    this.skySystem = skySystem;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.materials = new Set();
    this.texture = null;
    this._target = null;
    this._key = '';
    this.intensity = 1;
    this.mode = 'full';
    this.wet = 0;

    const env = new THREE.Scene();
    this.sky = new Sky();
    this.sky.scale.setScalar(40);
    env.add(this.sky);
    // Ground: dark asphalt-ish below the horizon.
    this.groundMat = new THREE.MeshBasicMaterial({ color: 0x1d1f23, side: THREE.DoubleSide });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(38, 32).rotateX(-Math.PI / 2), this.groundMat);
    ground.position.y = -1.5;
    env.add(ground);
    // Skyline: dark boxes around the horizon break up the reflections.
    this.boxMat = new THREE.MeshBasicMaterial({ color: 0x3a3f48 });
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      const h = 3 + ((k * 37) % 9);
      const m = new THREE.Mesh(box, this.boxMat);
      m.position.set(Math.sin(a) * 26, -1.5, Math.cos(a) * 26);
      m.scale.set(5 + (k % 3) * 2, h, 5);
      m.lookAt(0, -1.5, 0);
      env.add(m);
    }
    this.envScene = env;
  }

  setMode(mode) {
    this.mode = mode;
    this.scene.environment = mode === 'full' ? this.texture : null;
  }

  /** Register a material whose envMap / intensity are managed explicitly. */
  add(material) {
    this.materials.add(material);
    if (this.texture) this._apply(material);
  }

  remove(material) {
    this.materials.delete(material);
  }

  _apply(m) {
    // In 'cars' mode the (large) road surfaces only reflect while wet.
    const tex = this.mode === 'cars' && m.userData.envManual && this.wet < 0.05 ? null : this.texture;
    if (m.envMap !== tex) {
      m.envMap = tex;
      m.needsUpdate = true;
    }
  }

  /** sunDir: normalised; night 0..1; overcast 0..1. */
  update(sunDir, night, overcast = 0) {
    const q = (v, n) => Math.round(v * n);
    const key = `${q(sunDir.x, 12)},${q(sunDir.y, 30)},${q(sunDir.z, 12)},${q(overcast, 8)}`;
    if (key !== this._key) {
      this._key = key;
      this.skySystem.copyTo(this.sky);
      // The direct sun light already makes the highlight; a sun disc in the
      // env map would add a second, blown-out one on every glossy surface.
      this.sky.material.uniforms.showSunDisc.value = 0;
      const dark = 1 - night * 0.85;
      this.boxMat.color.setRGB(0.05, 0.055, 0.065).multiplyScalar(dark);
      this.groundMat.color.setRGB(0.035, 0.037, 0.042).multiplyScalar(dark);
      const target = this.pmrem.fromScene(this.envScene, 0.02);
      this._target?.dispose();
      this._target = target;
      this.texture = target.texture;
      if (this.mode === 'full') this.scene.environment = this.texture;
    }
    // The sky render is already dark at night; keep a little moonlit ambient.
    this.intensity = 0.42 * (1 - overcast * 0.25);
    this.scene.environmentIntensity = this.intensity;
    for (const m of this.materials) this._apply(m);
  }
}
