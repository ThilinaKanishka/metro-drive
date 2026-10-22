import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRng } from '../core/utils.js';
import { loadPrefs, savePrefs } from '../core/storage.js';

export const MODES = { free: 'Free Roam', taxi: 'Taxi', race: 'Checkpoint Race' };

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const YELLOW = 0xffc93c;
const GREEN = 0x3ddc84;
const BLUE = 0x4fc3f7;
const CHECKERED = 0xffffff;

/**
 * Mission modes:
 *  - free: just drive (drift points, penalties)
 *  - taxi: a waving passenger waits at the kerb; stop next to them, then drive
 *          to the marked destination before the timer runs out
 *  - race: a fixed checkpoint route through the streets with a countdown,
 *          lap timer and a saved best time
 *
 * Exposes `target` (for the HUD waypoint arrow) and `markers` (minimap).
 */
export class Missions {
  constructor({ scene, layout, peds, car, score, hud }) {
    this.layout = layout;
    this.peds = peds;
    this.car = car;
    this.score = score;
    this.hud = hud;
    this.mode = 'free';
    this.rng = createRng(Date.now() & 0xffff);
    this.markers = [];
    this.target = null;
    this.beacon = new Beacon(scene, 2.2);
    this.nextBeacon = new Beacon(scene, 6.5);
    this.ring = new Beacon(scene, 6.5);
  }

  setMode(mode) {
    this._cleanup();
    this.mode = mode in MODES ? mode : 'free';
    this.restart();
  }

  restart() {
    this._cleanup();
    this.target = null;
    this.markers = [];
    if (this.mode === 'taxi') this._newFare();
    else if (this.mode === 'race') this._setupRace();
    else this.hud.setMission(null);
  }

  _cleanup() {
    if (this.fare?.ped) this.peds.releaseFare(this.fare.ped);
    this.fare = null;
    this.race = null;
    this.car.controls.locked = false;
    this.beacon.hide();
    this.nextBeacon.hide();
    this.ring.hide();
    this.hud.countdown('');
  }

  /** The player knocked someone over: passengers don't tip for that. */
  onPedestrianHit() {
    if (this.fare?.state === 'ride') this.fare.incidents++;
  }

  onCrash() {
    if (this.fare?.state === 'ride') this.fare.incidents++;
  }

  // ---------------------------------------------------------------- taxi
  /**
   * Random kerb spot: a pedestrian position just inside the sidewalk and the
   * matching car stop position in the kerb-side lane.
   */
  _kerbSpot(x, z, minD, maxD) {
    const L = this.layout;
    const hr = L.cfg.roadWidth / 2;
    const { blocksX, blocksZ } = L.cfg;
    for (let k = 0; k < 200; k++) {
      const alongZ = this.rng.chance(0.5);
      const fixed = alongZ ? L.roadX : L.roadZ;
      const cross = alongZ ? L.roadZ : L.roadX;
      const i = this.rng.int(0, fixed.length - 1);
      const j = this.rng.int(0, cross.length - 2);
      const side = this.rng.chance(0.5) ? 1 : -1;
      const bi = side > 0 ? i : i - 1;
      if (bi < 0 || bi >= (alongZ ? blocksX : blocksZ)) continue;
      const along = cross[j] + hr + (cross[j + 1] - cross[j] - 2 * hr) * this.rng.range(0.3, 0.7);
      const pedLat = fixed[i] + side * (hr + 0.8);
      const carLat = fixed[i] + side * L.laneOffset;
      const s = {
        pedX: alongZ ? pedLat : along, pedZ: alongZ ? along : pedLat,
        carX: alongZ ? carLat : along, carZ: alongZ ? along : carLat,
        // The passenger faces the road.
        yaw: alongZ ? Math.atan2(-side, 0) : Math.atan2(0, -side),
      };
      const d = Math.hypot(s.carX - x, s.carZ - z);
      if (d < minD || d > maxD) continue;
      // Not right next to a parked car.
      if (L.parked?.some((v) => Math.abs(v.x - s.carX) < 7 && Math.abs(v.z - s.carZ) < 7)) continue;
      return s;
    }
    return null;
  }

  _newFare() {
    const p = this.car.physics;
    const spot = this._kerbSpot(p.x, p.z, 70, 260);
    if (!spot) return;
    const ped = this.peds.spawnFare(spot.pedX, spot.pedZ, spot.yaw);
    this.fare = { state: 'find', spot, ped, timer: 0, incidents: 0 };
    this.beacon.show(spot.carX, spot.carZ, YELLOW);
    this.target = { x: spot.carX, z: spot.carZ, label: 'Passenger' };
    this.markers = [{ x: spot.carX, z: spot.carZ, color: '#ffc93c' }];
  }

  _updateTaxi(dt, speed) {
    const f = this.fare;
    if (!f) {
      this._newFare();
      return;
    }
    const p = this.car.physics;
    const cfg = CONFIG.missions.taxi;
    if (f.state === 'find') {
      const d = Math.hypot(f.spot.carX - p.x, f.spot.carZ - p.z);
      this.hud.setMission({ title: 'TAXI', text: d < 12 ? 'Stop next to the passenger' : 'Pick up the passenger' });
      if (d < 8 && speed < 2.5) {
        f.state = 'board';
        this.peds.boardFare(f.ped, p.x, p.z);
        this.beacon.hide();
        this.hud.setMission({ title: 'TAXI', text: 'Passenger getting in…' });
      }
    } else if (f.state === 'board') {
      if (f.ped.hidden) {
        const dest = this._kerbSpot(p.x, p.z, cfg.minDistance, cfg.maxDistance);
        if (!dest) return;
        const dist = Math.abs(dest.carX - p.x) + Math.abs(dest.carZ - p.z);
        f.dest = dest;
        f.distance = dist;
        f.state = 'ride';
        f.timer = dist / cfg.speedAllowance + cfg.baseTime;
        f.total = f.timer;
        this.beacon.show(dest.carX, dest.carZ, GREEN);
        this.target = { x: dest.carX, z: dest.carZ, label: 'Destination' };
        this.markers = [{ x: dest.carX, z: dest.carZ, color: '#3ddc84' }];
      }
    } else if (f.state === 'ride') {
      f.timer -= dt;
      const d = Math.hypot(f.dest.carX - p.x, f.dest.carZ - p.z);
      this.hud.setMission({
        title: 'TAXI',
        text: d < 14 ? 'Stop at the green marker' : 'Drive to the destination',
        timer: formatTime(Math.max(f.timer, 0)),
        urgent: f.timer < 10,
      });
      if (d < 9 && speed < 2.5) {
        const fare = Math.round(cfg.baseFare + f.distance * cfg.farePerMetre);
        const tip = Math.max(0, Math.round(f.timer * cfg.tipPerSecond) - f.incidents * 15);
        this.score.earn(fare + tip, tip > 0 ? `Fare + $${tip} tip` : 'Fare');
        this.score.add(100 + Math.round(f.timer * 5), 'Delivered');
        this.peds.releaseFare(f.ped, f.dest.pedX, f.dest.pedZ);
        this.fare = null;
        this.beacon.hide();
        this.target = null;
        this.markers = [];
        this.hud.toast('Passenger delivered!', 2);
      } else if (f.timer <= 0) {
        this.score.add(-50, 'Fare lost');
        this.hud.toast('Too slow - the passenger got out', 2.5);
        this.peds.releaseFare(f.ped, p.x, p.z);
        this.fare = null;
        this.beacon.hide();
        this.target = null;
        this.markers = [];
      }
    }
  }

  // ---------------------------------------------------------------- race
  /** Fixed route (seeded) so best times are comparable. */
  _setupRace() {
    const L = this.layout;
    const rng = createRng(CONFIG.missions.race.seed);
    const nx = L.roadX.length;
    const nz = L.roadZ.length;
    const has = (i, j) => i >= 0 && j >= 0 && i < nx && j < nz;
    let i = Math.floor(nx / 2);
    let j = 1;
    let dir = 1;
    const visited = new Set([i * 100 + j]);
    const nodes = [{ x: L.roadX[i], z: L.roadZ[j] }];
    for (let n = 1; n < CONFIG.missions.race.checkpoints; n++) {
      const options = [];
      for (let d = 0; d < 4; d++) {
        if (d === (dir + 2) % 4) continue;
        const ni = i + DIRS[d][0];
        const nj = j + DIRS[d][1];
        if (!has(ni, nj) || visited.has(ni * 100 + nj)) continue;
        options.push(d);
        if (d === dir) options.push(d, d); // favour straights: faster, more fun
      }
      if (!options.length) break;
      dir = rng.pick(options);
      i += DIRS[dir][0];
      j += DIRS[dir][1];
      visited.add(i * 100 + j);
      nodes.push({ x: L.roadX[i], z: L.roadZ[j] });
    }
    // Start on the road segment before the first node, facing it.
    const startI = Math.floor(nx / 2);
    const sx = L.roadX[startI] - L.laneOffset;
    const sz = L.roadZ[1] - L.cell * 0.55;
    this.car.physics.reset(sx, sz, 0);
    this.car.syncVisual(0);
    this.onTeleport?.();

    const best = Number(loadPrefs().raceBest) || 0;
    let length = Math.hypot(nodes[0].x - sx, nodes[0].z - sz);
    for (let k = 1; k < nodes.length; k++) length += Math.hypot(nodes[k].x - nodes[k - 1].x, nodes[k].z - nodes[k - 1].z);
    this.race = { nodes, index: 0, time: 0, countdown: 3.5, best, state: 'countdown', par: length / CONFIG.missions.race.parSpeed };
    this.car.controls.locked = true;
    this._showCheckpoints();
  }

  _showCheckpoints() {
    const r = this.race;
    const cur = r.nodes[r.index];
    const last = r.index === r.nodes.length - 1;
    this.ring.show(cur.x, cur.z, last ? CHECKERED : BLUE, 0.6);
    const nxt = r.nodes[r.index + 1];
    if (nxt) this.nextBeacon.show(nxt.x, nxt.z, BLUE, 0.35);
    else this.nextBeacon.hide();
    this.target = { x: cur.x, z: cur.z, label: last ? 'Finish' : `Checkpoint ${r.index + 1}` };
    this.markers = r.nodes.slice(r.index, r.index + 3).map((n, k) => ({
      x: n.x, z: n.z, color: k === 0 ? '#4fc3f7' : 'rgba(79,195,247,0.45)',
    }));
  }

  _updateRace(dt) {
    const r = this.race;
    if (!r) return;
    const best = r.best ? `   Best ${formatTime(r.best, true)}` : '';
    if (r.state === 'countdown') {
      r.countdown -= dt;
      const n = Math.ceil(r.countdown - 0.5);
      this.hud.countdown(n > 0 ? String(n) : 'GO!');
      this.hud.setMission({ title: 'RACE', text: `Checkpoints: ${r.nodes.length}${best}`, timer: formatTime(0, true) });
      if (r.countdown <= 0.5) {
        r.state = 'running';
        this.car.controls.locked = false;
      }
      return;
    }
    if (r.state === 'running') {
      if (r.countdown > -1) {
        r.countdown -= dt;
        if (r.countdown <= -0.5) this.hud.countdown('');
      }
      r.time += dt;
      const p = this.car.physics;
      const cp = r.nodes[r.index];
      if (Math.hypot(cp.x - p.x, cp.z - p.z) < CONFIG.missions.race.radius) {
        r.index++;
        if (r.index >= r.nodes.length) {
          this._finishRace();
          return;
        }
        this.score.add(50, `Checkpoint ${r.index}/${r.nodes.length}`);
        this._showCheckpoints();
      }
      this.hud.setMission({
        title: 'RACE',
        text: `Checkpoint ${r.index + 1} / ${r.nodes.length}${best}`,
        timer: formatTime(r.time, true),
      });
    }
  }

  _finishRace() {
    const r = this.race;
    r.state = 'finished';
    this.ring.hide();
    this.nextBeacon.hide();
    this.target = null;
    this.markers = [];
    const record = !r.best || r.time < r.best;
    if (record) savePrefs({ raceBest: r.time });
    // Beating par pays more, capped so shortcuts can't print money.
    const ratio = Math.min(r.par / r.time, 1.6);
    this.score.earn(Math.round(Math.max(100, 600 * ratio)), 'Race prize');
    this.score.add(Math.round(2000 * ratio), 'Finish');
    this.hud.countdown(record ? 'NEW RECORD!' : 'FINISH');
    this.hud.setMission({
      title: 'RACE',
      text: `Finished ${formatTime(r.time, true)}${record ? ' - new best!' : `   Best ${formatTime(r.best, true)}`}   (Pause → Restart to race again)`,
    });
    setTimeout(() => this.race?.state === 'finished' && this.hud.countdown(''), 3000);
  }

  // ---------------------------------------------------------------- update
  update(dt, speed, time) {
    if (dt <= 0) return;
    if (this.mode === 'taxi') this._updateTaxi(dt, speed);
    else if (this.mode === 'race') this._updateRace(dt);
    for (const b of [this.beacon, this.nextBeacon, this.ring]) b.update(time);
  }
}

export function formatTime(t, tenths = false) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return tenths ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/**
 * A tall translucent light column with a pulsing ground ring: visible over
 * buildings and through fog, so the destination can be found by eye.
 */
class Beacon {
  constructor(scene, radius) {
    this.group = new THREE.Group();
    this.group.visible = false;
    const tex = makeColumnTexture();
    this.colMat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, fog: false,
    });
    const col = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 60, 24, 1, true).translate(0, 30, 0), this.colMat);
    this.ringMat = new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.ringMesh = new THREE.Mesh(new THREE.RingGeometry(radius * 0.8, radius, 40).rotateX(-Math.PI / 2), this.ringMat);
    this.ringMesh.position.y = 0.06;
    col.renderOrder = this.ringMesh.renderOrder = 4;
    this.group.add(col, this.ringMesh);
    scene.add(this.group);
    this.strength = 1;
  }

  show(x, z, color, strength = 1) {
    this.group.position.set(x, 0, z);
    this.colMat.color.set(color);
    this.ringMat.color.set(color);
    this.strength = strength;
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  update(time) {
    if (!this.group.visible) return;
    const pulse = 0.5 + 0.5 * Math.sin(time * 4);
    this.colMat.opacity = (0.55 + pulse * 0.25) * this.strength;
    this.ringMat.opacity = (0.5 + pulse * 0.5) * this.strength;
    this.ringMesh.scale.setScalar(1 + pulse * 0.08);
  }
}

/** Vertical gradient: bright at the base, fading upward. */
function makeColumnTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
