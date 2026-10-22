import * as THREE from 'three';

/**
 * Reflection environment for cars and wet roads. A tiny scene (sky gradient
 * dome, dark ground and a ring of skyline boxes) is pre-filtered with PMREM
 * into an env map. It is re-rendered only when the sky changes noticeably
 * (time of day / weather), so the cost is a few ms every several seconds.
 *
 * The env map is assigned to selected materials only (car paint and glass,
 * wet asphalt): putting it on scene.environment would relight every material
 * in the city and change its look.
 */
export class ReflectionEnvironment {
  constructor(renderer) {
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.materials = new Set();
    this.texture = null;
    this._target = null;
    this._key = '';
    this.intensity = 1;

    const scene = new THREE.Scene();
    this.uniforms = {
      top: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      ground: { value: new THREE.Color(0x25272b) },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(50, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
          varying vec3 vDir;
          void main() {
            float h = vDir.y;
            vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, ground, smoothstep(0.0, 0.15, -h));
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    scene.add(sky);
    // Skyline: dark boxes around the horizon break up the reflections.
    this.boxMat = new THREE.MeshBasicMaterial({ color: 0x3a3f48 });
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * Math.PI * 2;
      const h = 4 + ((k * 37) % 11);
      const m = new THREE.Mesh(box, this.boxMat);
      m.position.set(Math.sin(a) * 30, -2, Math.cos(a) * 30);
      m.scale.set(5 + (k % 3) * 2, h, 5);
      m.lookAt(0, -2, 0);
      scene.add(m);
    }
    this.scene = scene;
  }

  /** Register a material to receive the env map. */
  add(material, strength = 1) {
    material.userData.envStrength = strength;
    this.materials.add(material);
    if (this.texture) this._apply(material);
  }

  remove(material) {
    this.materials.delete(material);
  }

  _apply(m) {
    if (m.envMap !== this.texture) {
      m.envMap = this.texture;
      m.needsUpdate = true;
    }
    // Some materials (wet roads) drive their own intensity.
    if (!m.userData.envManual) m.envMapIntensity = this.intensity * (m.userData.envStrength ?? 1);
  }

  /**
   * Re-render if the sky changed enough. skyTop / skyHorizon: current sky
   * colours, night 0..1 (dims reflections).
   */
  update(skyTop, skyHorizon, night) {
    this.intensity = 1 - night * 0.75;
    const q = (c) => `${Math.round(c.r * 20)},${Math.round(c.g * 20)},${Math.round(c.b * 20)}`;
    const key = q(skyTop) + q(skyHorizon);
    if (key !== this._key) {
      this._key = key;
      this.uniforms.top.value.copy(skyTop);
      this.uniforms.horizon.value.copy(skyHorizon);
      this.boxMat.color.setRGB(0.23, 0.25, 0.28).multiplyScalar(1 - night * 0.8);
      const target = this.pmrem.fromScene(this.scene, 0.03);
      this._target?.dispose();
      this._target = target;
      this.texture = target.texture;
    }
    for (const m of this.materials) this._apply(m);
  }
}
