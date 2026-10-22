import * as THREE from 'three';
import { PED_STATE } from './pedestrians.js';

const { FALLEN, GETUP } = PED_STATE;

/**
 * Low-poly people drawn with six InstancedMeshes (legs, hips, torso, arms,
 * head, hair) with per-instance colours, i.e. six draw calls for everyone.
 *
 * Every frame the visible people are packed into the instance buffers:
 * anyone beyond the draw distance or behind the camera is skipped, and limbs
 * only swing within `animDistance` (further away nobody can tell).
 *
 * Person local space: feet at y = 0, facing +Z.
 */
export class PedestrianRenderer {
  constructor(scene, peds) {
    this.peds = peds;
    const max = 400;
    this.max = max;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const skinMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const mk = (geo, material, n, shadow) => {
      const m = new THREE.InstancedMesh(geo, material, n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = shadow;
      m.count = 0;
      m.setColorAt(0, new THREE.Color());
      scene.add(m);
      return m;
    };
    this.legs = mk(new THREE.BoxGeometry(0.14, 0.84, 0.15).translate(0, -0.42, 0), mat, max * 2, true);
    this.hips = mk(new THREE.BoxGeometry(0.36, 0.17, 0.21), mat, max, false);
    this.torso = mk(new THREE.BoxGeometry(0.4, 0.56, 0.23), mat, max, true);
    this.arms = mk(new THREE.BoxGeometry(0.1, 0.56, 0.11).translate(0, -0.27, 0), mat, max * 2, false);
    this.head = mk(new THREE.IcosahedronGeometry(0.13, 1), skinMat, max, true);
    this.hair = mk(new THREE.BoxGeometry(0.29, 0.1, 0.29).translate(0, 0.05, 0), mat, max, false);
    this.meshes = [this.legs, this.hips, this.torso, this.arms, this.head, this.hair];

    this._root = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._out = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
    this._fwd = new THREE.Vector3();
    this.time = 0;
  }

  _part(mesh, index, x, y, z, rx, ry, rz, sx = 1, sy = 1, sz = 1) {
    this._e.set(rx, ry, rz);
    this._local.compose(this._p.set(x, y, z), this._q.setFromEuler(this._e), this._s.set(sx, sy, sz));
    mesh.setMatrixAt(index, this._out.multiplyMatrices(this._root, this._local));
  }

  update(dt, camera) {
    this.time += dt;
    const cfg = this.peds.cfg;
    camera.getWorldDirection(this._fwd);
    const eye = camera.position;
    let n = 0;
    const c = this._c;

    for (const p of this.peds.list) {
      // Animation phase follows ground speed (stride length ~0.75 m).
      p.phase += p.speed * dt * 4.3 / p.scale;
      if (!p.visible || n >= this.max) continue;
      // Behind the camera?
      const rx = p.x - eye.x;
      const rz = p.z - eye.z;
      if (p.dist > 6 && rx * this._fwd.x + rz * this._fwd.z < -2) continue;

      // Root: position (+hop), fall rotation about the horizontal axis
      // perpendicular to the fall direction, yaw, scale.
      const fallen = p.state === FALLEN || p.state === GETUP;
      const f = fallen ? p.fall * p.fall * (3 - 2 * p.fall) : 0;
      this._qy.setFromAxisAngle(this._up, p.yaw);
      if (f > 0) {
        this._axis.set(p.fallZ, 0, -p.fallX).normalize();
        this._q.setFromAxisAngle(this._axis, f * (Math.PI / 2 - 0.06)).multiply(this._qy);
      } else this._q.copy(this._qy);
      const bob = Math.abs(Math.sin(p.phase)) * 0.035 * Math.min(p.speed, 2);
      this._root.compose(
        this._v.set(p.x, p.hop + bob + f * 0.12 * p.scale, p.z),
        this._q,
        this._s.setScalar(p.scale),
      );

      // Limb swing (static further away).
      const running = p.speed > 2.5;
      let swing = 0;
      if (p.dist < cfg.animDistance && p.speed > 0.05) swing = Math.sin(p.phase) * (running ? 0.85 : 0.5);
      const idleSway = p.speed < 0.05 ? Math.sin(this.time * 1.3 + p.id) * 0.05 : 0;
      const lean = running ? 0.18 : 0;
      const spread = fallen ? f * 1.1 : 0.06;

      this._part(this.legs, n * 2, 0.1, 0.86, 0, swing, 0, fallen ? f * 0.25 : 0);
      this._part(this.legs, n * 2 + 1, -0.1, 0.86, 0, -swing, 0, fallen ? -f * 0.25 : 0);
      this._part(this.hips, n, 0, 0.92, 0, 0, 0, 0);
      this._part(this.torso, n, 0, 1.27, 0.02 * lean, lean, 0, 0);
      this._part(this.arms, n * 2, 0.26, 1.5, 0.05 * lean, -swing * 0.9 + idleSway, 0, spread);
      // Taxi passengers hail with the right arm.
      const rightArm = p.waving ? -2.7 + Math.sin(this.time * 7) * 0.25 : swing * 0.9 - idleSway;
      this._part(this.arms, n * 2 + 1, -0.26, 1.5, 0.05 * lean, rightArm, 0, p.waving ? -0.25 : -spread);
      this._part(this.head, n, 0, 1.7, 0.06 * lean, 0, p.headYaw, 0);
      if (p.longHair) this._part(this.hair, n, 0, 1.56, -0.06 + 0.06 * lean, 0, p.headYaw, 0, 1, 2.8, 0.82);
      else this._part(this.hair, n, 0, 1.78, 0.06 * lean, 0, p.headYaw, 0, 1, 1, 1);

      c.set(p.bottom);
      this.legs.setColorAt(n * 2, c);
      this.legs.setColorAt(n * 2 + 1, c);
      this.hips.setColorAt(n, c);
      c.set(p.top);
      this.torso.setColorAt(n, c);
      this.arms.setColorAt(n * 2, c);
      this.arms.setColorAt(n * 2 + 1, c);
      this.head.setColorAt(n, c.set(p.skin));
      this.hair.setColorAt(n, c.set(p.hair));
      n++;
    }

    const counts = [n * 2, n, n, n * 2, n, n];
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    });
    this.visibleCount = n;
  }
}
