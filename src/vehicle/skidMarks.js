import * as THREE from 'three';

const MAX_MARKS = 800;     // ring buffer size (oldest marks are overwritten)
const MIN_STEP = 0.3;      // metres between marks
const WIDTH = 0.24;

const FADE_START = 12;     // seconds before a mark starts to fade
const FADE_END = 25;       // fully gone

/**
 * Tyre marks left by the rear wheels while sliding. One InstancedMesh used
 * as a ring buffer, so marks cost a single draw call. Each mark stores its
 * birth time; the shader fades old marks out.
 */
export class SkidMarks {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.45, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    this.birth = new Float32Array(MAX_MARKS).fill(-1e6);
    this.birthAttr = new THREE.InstancedBufferAttribute(this.birth, 1);
    geo.setAttribute('aBirth', this.birthAttr);
    this.time = { value: 0 };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aBirth;
          uniform float uTime;
          varying float vFade;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vFade = 1.0 - smoothstep(${FADE_START.toFixed(1)}, ${FADE_END.toFixed(1)}, uTime - aBirth);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vFade;`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          gl_FragColor.a *= vFade;`);
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_MARKS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.next = 0;
    this.last = [null, null]; // last mark position per rear wheel
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /** Call every frame with the car physics state. */
  update(phys, dt = 0) {
    this.time.value += dt;
    const sliding = phys.skid > 0.35 && phys.speed > 2;
    if (!sliding) {
      this.last[0] = this.last[1] = null;
      return;
    }
    const s = Math.sin(phys.heading);
    const c = Math.cos(phys.heading);
    for (let w = 0; w < 2; w++) {
      const side = w === 0 ? 0.8 : -0.8;
      // Rear axle contact patch: forward -1.3, left +/-0.8.
      const x = phys.x + s * -1.3 + c * side;
      const z = phys.z + c * -1.3 - s * side;
      const prev = this.last[w];
      if (!prev) {
        this.last[w] = { x, z };
        continue;
      }
      const dx = x - prev.x;
      const dz = z - prev.z;
      const len = Math.hypot(dx, dz);
      if (len < MIN_STEP) continue;
      if (len < 3) this._add((x + prev.x) / 2, (z + prev.z) / 2, Math.atan2(dx, dz), len);
      prev.x = x;
      prev.z = z;
    }
  }

  _add(x, z, yaw, len) {
    this._q.setFromAxisAngle(this._up, yaw);
    this._m.compose(this._p.set(x, 0.025, z), this._q, this._s.set(WIDTH, 1, len + 0.05));
    this.mesh.setMatrixAt(this.next, this._m);
    this.birth[this.next] = this.time.value;
    this.birthAttr.needsUpdate = true;
    this.next = (this.next + 1) % MAX_MARKS;
    this.mesh.count = Math.min(this.mesh.count + 1, MAX_MARKS);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
    this.next = 0;
    this.last[0] = this.last[1] = null;
  }
}
