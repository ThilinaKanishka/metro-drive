import * as THREE from 'three';
import { CONFIG } from '../config.js';

/**
 * Signalised intersections. Every junction with three or more approaches gets
 * a two-phase controller: X-axis traffic green → yellow → all-red, then the
 * Z axis. Junctions are offset in time so the city doesn't switch in unison.
 * Pedestrians walking parallel to the green axis get the walk signal (minus
 * a "flashing don't walk" tail).
 *
 * Visuals: per approach a pole on the far-right corner with an arm over the
 * lane and a three-lamp head facing oncoming traffic, plus pedestrian heads
 * on the pole facing across each crosswalk. All instanced (~6 draw calls).
 */
export const GREEN = 0;
export const YELLOW = 1;
export const RED = 2;

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const LAMP_ON = [new THREE.Color(1.0, 0.12, 0.08), new THREE.Color(1.0, 0.7, 0.05), new THREE.Color(0.15, 1.0, 0.45)];
const LAMP_OFF = [new THREE.Color(0.16, 0.03, 0.03), new THREE.Color(0.16, 0.12, 0.02), new THREE.Color(0.02, 0.14, 0.06)];
const WALK = new THREE.Color(0.75, 1.0, 0.9);
const DONT = new THREE.Color(1.0, 0.42, 0.08);
const PED_OFF = new THREE.Color(0.08, 0.05, 0.03);

export class TrafficLights {
  constructor(scene, layout) {
    this.layout = layout;
    this.cfg = CONFIG.trafficLights;
    const c = this.cfg;
    this.half = c.green + c.yellow + c.allRed;
    this.cycle = this.half * 2;
    this.time = 0;
    this.nx = layout.roadX.length;
    this.nz = layout.roadZ.length;
    this.signals = new Map(); // key i*100+j -> { offset }
    this.heads = [];          // car signal heads
    this.pedHeads = [];       // pedestrian signal heads
    this._build(scene);
  }

  hasNode(i, j) {
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz;
  }

  isSignalized(i, j) {
    return this.signals.has(i * 100 + j);
  }

  /** Phase position of junction (i, j) for an axis (0 = X, 1 = Z): time into its window. */
  _axisTime(i, j, axis) {
    const s = this.signals.get(i * 100 + j);
    const t = (this.time + s.offset) % this.cycle;
    return axis === 0 ? t : (t + this.half) % this.cycle;
  }

  /** GREEN / YELLOW / RED for traffic travelling in direction `dir` into (i, j). */
  carState(i, j, dir) {
    if (!this.isSignalized(i, j)) return GREEN;
    const u = this._axisTime(i, j, dir % 2);
    if (u < this.cfg.green) return GREEN;
    if (u < this.cfg.green + this.cfg.yellow) return YELLOW;
    return RED;
  }

  /** Seconds until the signal for `dir` changes. */
  timeToChange(i, j, dir) {
    const u = this._axisTime(i, j, dir % 2);
    const c = this.cfg;
    if (u < c.green) return c.green - u;
    if (u < c.green + c.yellow) return c.green + c.yellow - u;
    return this.cycle - u;
  }

  /**
   * Pedestrian signal for walking along `walkAxis` (0 = along X) at (i, j):
   * 'walk', 'flash' (finish crossing, don't start) or 'dont'.
   * Unsignalised junctions always return 'walk' (pedestrians look for cars).
   */
  walkState(i, j, walkAxis) {
    if (!this.isSignalized(i, j)) return 'walk';
    const u = this._axisTime(i, j, walkAxis);
    if (u < this.cfg.green - this.cfg.walkFlash) return 'walk';
    if (u < this.cfg.green) return 'flash';
    return 'dont';
  }

  // ------------------------------------------------------------------ build
  _blockIndex(i, j, sx, sz) {
    const ix = sx > 0 ? i : i - 1;
    const iz = sz > 0 ? j : j - 1;
    const { blocksX, blocksZ } = this.layout.cfg;
    if (ix < 0 || iz < 0 || ix >= blocksX || iz >= blocksZ) return -1;
    return iz * blocksX + ix;
  }

  _build(scene) {
    const L = this.layout;
    const hr = L.cfg.roadWidth / 2;
    const cornerOff = hr + 0.9;
    const armLen = cornerOff - L.laneOffset;
    const poles = [];

    for (let i = 0; i < this.nx; i++) {
      for (let j = 0; j < this.nz; j++) {
        const approaches = [0, 1, 2, 3].filter((d) => this.hasNode(i - DIRS[d][0], j - DIRS[d][1]));
        if (approaches.length < 3) continue;
        // Offsets give a loose green wave across the grid.
        this.signals.set(i * 100 + j, { offset: (((i * 7 + j * 3) % 10) / 10) * this.cycle });
        const cx = L.roadX[i];
        const cz = L.roadZ[j];

        for (const d of approaches) {
          const [dx, dz] = DIRS[d];
          const rx = -dz;
          const rz = dx;
          // Far-right corner if there is a block there, else near-right.
          let side = 1;
          let bi = this._blockIndex(i, j, Math.sign(dx + rx), Math.sign(dz + rz));
          if (bi < 0) {
            side = -1;
            bi = this._blockIndex(i, j, Math.sign(-dx + rx), Math.sign(-dz + rz));
            if (bi < 0) continue;
          }
          const px = cx + dx * cornerOff * side + rx * cornerOff;
          const pz = cz + dz * cornerOff * side + rz * cornerOff;
          poles.push({ x: px, z: pz });
          L._addCircle(bi, px, pz, 0.2);
          this.heads.push({
            i, j, dir: d, state: -1,
            x: px - rx * armLen, z: pz - rz * armLen,
            armX: px - rx * armLen / 2, armZ: pz - rz * armLen / 2,
            armYaw: Math.atan2(-rx, -rz), yaw: Math.atan2(-dx, -dz),
            fx: -dx, fz: -dz,
          });
          // Pedestrian heads on this pole, facing across each adjacent crosswalk.
          const sx = Math.sign(px - cx);
          const sz = Math.sign(pz - cz);
          if (this.hasNode(i, j + sz)) this.pedHeads.push({ i, j, axis: 0, x: px - sx * 0.16, z: pz, yaw: Math.atan2(-sx, 0), state: '' });
          if (this.hasNode(i + sx, j)) this.pedHeads.push({ i, j, axis: 1, x: px, z: pz - sz * 0.16, yaw: Math.atan2(0, -sz), state: '' });
        }
      }
    }

    const group = new THREE.Group();
    group.name = 'trafficLights';
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.6, metalness: 0.5 });
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.7 });
    const lampMat = new THREE.MeshBasicMaterial();

    const poleH = 5.7;
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, poleH, 6).translate(0, poleH / 2, 0);
    const armGeo = new THREE.BoxGeometry(0.1, 0.1, armLen);
    const headGeo = new THREE.BoxGeometry(0.42, 1.12, 0.32);
    const pedGeo = new THREE.BoxGeometry(0.34, 0.5, 0.22);
    const lampGeo = new THREE.CircleGeometry(0.13, 10);
    const pedLampGeo = new THREE.PlaneGeometry(0.24, 0.2);

    const nH = this.heads.length;
    const nP = this.pedHeads.length;
    this.poleMesh = new THREE.InstancedMesh(poleGeo, metal, poles.length);
    this.armMesh = new THREE.InstancedMesh(armGeo, metal, nH);
    this.headMesh = new THREE.InstancedMesh(headGeo, housingMat, nH + nP);
    this.lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, nH * 3);
    this.pedLampMesh = new THREE.InstancedMesh(pedLampGeo, lampMat, Math.max(nP, 1));

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    poles.forEach((pl, k) => this.poleMesh.setMatrixAt(k, m.compose(p.set(pl.x, 0, pl.z), q.identity(), s)));
    this.heads.forEach((h, k) => {
      q.setFromAxisAngle(up, h.armYaw);
      this.armMesh.setMatrixAt(k, m.compose(p.set(h.armX, poleH - 0.25, h.armZ), q, s));
      q.setFromAxisAngle(up, h.yaw);
      this.headMesh.setMatrixAt(k, m.compose(p.set(h.x, poleH - 0.85, h.z), q, s));
      for (let l = 0; l < 3; l++) {
        const y = poleH - 0.85 + (1 - l) * 0.34; // red top, yellow, green bottom
        this.lampMesh.setMatrixAt(k * 3 + l, m.compose(p.set(h.x + h.fx * 0.17, y, h.z + h.fz * 0.17), q, s));
      }
    });
    this.pedHeads.forEach((h, k) => {
      q.setFromAxisAngle(up, h.yaw);
      this.headMesh.setMatrixAt(nH + k, m.compose(p.set(h.x, 2.7, h.z), q, s));
      const fx = Math.sin(h.yaw);
      const fz = Math.cos(h.yaw);
      this.pedLampMesh.setMatrixAt(k, m.compose(p.set(h.x + fx * 0.12, 2.7, h.z + fz * 0.12), q, s));
    });
    // Instance colour buffers exist only after the first setColorAt.
    for (let k = 0; k < nH * 3; k++) this.lampMesh.setColorAt(k, LAMP_OFF[k % 3]);
    for (let k = 0; k < nP; k++) this.pedLampMesh.setColorAt(k, PED_OFF);
    this.pedLampMesh.count = nP;

    this.poleMesh.castShadow = this.armMesh.castShadow = this.headMesh.castShadow = true;
    for (const mesh of [this.poleMesh, this.armMesh, this.headMesh, this.lampMesh, this.pedLampMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }
    scene.add(group);
    this.group = group;
  }

  /**
   * Red-light check for the player. Call every frame; returns the junction
   * {i, j} once when the player drives into it against a red light.
   */
  checkPlayer(x, z, vx, vz) {
    const L = this.layout;
    const hr = L.cfg.roadWidth / 2;
    const i = Math.round((x - L.roadX[0]) / L.cell);
    const j = Math.round((z - L.roadZ[0]) / L.cell);
    const inside = this.hasNode(i, j) && Math.abs(x - L.roadX[i]) < hr && Math.abs(z - L.roadZ[j]) < hr;
    const key = inside ? i * 100 + j : -1;
    const entered = inside && key !== this._playerBox;
    this._playerBox = key;
    if (!entered || !this.isSignalized(i, j) || Math.hypot(vx, vz) < 2.5) return null;
    const dir = Math.abs(vx) > Math.abs(vz) ? (vx > 0 ? 0 : 2) : (vz > 0 ? 1 : 3);
    if (this.carState(i, j, dir) !== RED) return null;
    // Grace period: the light must have been red for a moment.
    const sinceRed = this._axisTime(i, j, dir % 2) - this.cfg.green - this.cfg.yellow;
    return sinceRed > 0.4 ? { i, j } : null;
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    let dirty = false;
    // Lamp order per head: 0 red, 1 yellow, 2 green.
    const lampFor = [2, 1, 0];
    for (let k = 0; k < this.heads.length; k++) {
      const h = this.heads[k];
      const st = this.carState(h.i, h.j, h.dir);
      if (st === h.state) continue;
      h.state = st;
      dirty = true;
      const on = lampFor[st];
      for (let l = 0; l < 3; l++) {
        this.lampMesh.setColorAt(k * 3 + l, l === on ? LAMP_ON[l] : LAMP_OFF[l]);
      }
    }
    if (dirty) this.lampMesh.instanceColor.needsUpdate = true;

    // Pedestrian heads: steady walk, flashing orange, steady orange.
    const blink = (this.time % 1) < 0.5;
    let pedDirty = false;
    for (let k = 0; k < this.pedHeads.length; k++) {
      const h = this.pedHeads[k];
      let st = this.walkState(h.i, h.j, h.axis);
      if (st === 'flash') st = blink ? 'dont' : 'off';
      if (st === h.state) continue;
      h.state = st;
      pedDirty = true;
      this.pedLampMesh.setColorAt(k, st === 'walk' ? WALK : st === 'dont' ? DONT : PED_OFF);
    }
    if (pedDirty) this.pedLampMesh.instanceColor.needsUpdate = true;
  }
}
