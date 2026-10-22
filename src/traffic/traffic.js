import { CONFIG, KMH } from '../config.js';
import { createRng } from '../core/utils.js';
import { carCircles } from '../vehicle/collision.js';
import { getVehicleShape } from '../vehicle/vehicleShapes.js';
import { GREEN, YELLOW } from './trafficLights.js';

/**
 * AI traffic on the road grid.
 *
 * The road network is a grid graph: nodes are intersections (i, j), edges the
 * road segments between them. Each vehicle drives in the right-hand lane of an
 * edge ("straight" segment), then through the intersection on a quadratic
 * Bezier ("turn" segment, which is also used for going straight on), picking
 * a random exit that is not a U-turn.
 *
 * Behaviour:
 *  - speed control is the Intelligent Driver Model (IDM): smooth acceleration,
 *    a time-headway gap to the vehicle ahead and comfortable braking
 *  - obeys traffic lights (stops at the stop line on red, on yellow only if it
 *    can stop comfortably); left turns yield to oncoming traffic
 *  - unsignalised junctions use a first-come reservation
 *  - stops for pedestrians on the road, indicates before turning, honks when
 *    the player blocks it
 *  - vehicles spawn in a ring around the player and are recycled when far
 *    away, so the city stays busy wherever you drive
 */
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // +x, +z, -x, -z
const STOP_OFFSET = 6.4;  // centre of a waiting sedan, from intersection edge
const EXIT_OFFSET = 3.0;  // where the next straight begins after an intersection
const SEDAN_HALF = 2.2;   // stop geometry is laid out for a sedan's front bumper

// right(d) = (-dz, dx) for right-hand traffic.
const rightOf = (d) => [-DIRS[d][1], DIRS[d][0]];

export class Traffic {
  constructor(layout, lights) {
    this.layout = layout;
    this.lights = lights;
    this.cfg = CONFIG.traffic;
    this.rng = createRng(CONFIG.city.seed + 7);
    this.vehicles = [];
    this.parked = [];
    this.peds = [];            // [{x, z, onRoad}] fed by the pedestrian system
    this.intersections = new Map();
    this.nx = layout.roadX.length;
    this.nz = layout.roadZ.length;
    this.lane = layout.laneOffset;
    this.halfRoad = layout.cfg.roadWidth / 2;
    this.density = this.cfg.defaultDensity;
    this.radiusScale = 1;      // draw-distance setting scales the spawn ring
    this.speedScale = 1;       // weather: everyone drives a little slower in rain / fog
    this.countScale = 1;       // graphics quality scales the vehicle count
    this._uid = 0;
    this._circles = [];
    this.onSpawn = null;       // (vehicle) => void   (renderer hooks)
    this.onDespawn = null;
    this.onHonk = null;        // (vehicle) => void

    const types = Object.entries(this.cfg.types);
    this._typeTable = types;
    this._typeWeight = types.reduce((s, [, t]) => s + t.weight, 0);
    this._generateParking();
  }

  /** Compatibility alias: the moving vehicles. */
  get cars() {
    return this.vehicles;
  }

  get target() {
    return Math.round((this.cfg.density[this.density] ?? this.cfg.density.medium) * this.countScale);
  }

  setDensity(level) {
    if (level in this.cfg.density) this.density = level;
  }

  // ------------------------------------------------------------ graph helpers
  nodePos(i, j) {
    return [this.layout.roadX[i], this.layout.roadZ[j]];
  }

  hasNode(i, j) {
    return i >= 0 && j >= 0 && i < this.nx && j < this.nz;
  }

  /** Random exit direction at node (i, j) arriving with direction d (no U-turns). */
  chooseNext(i, j, d) {
    const options = [];
    for (let k = 0; k < 4; k++) {
      if (k === (d + 2) % 4) continue;
      if (!this.hasNode(i + DIRS[k][0], j + DIRS[k][1])) continue;
      // Prefer going straight a bit more often.
      options.push(k);
      if (k === d) options.push(k);
    }
    return options.length ? this.rng.pick(options) : (d + 2) % 4;
  }

  /** Straight segment along edge ending at node (i, j) travelling in direction d. */
  makeStraight(i, j, d) {
    const [bx, bz] = this.nodePos(i, j);
    const [ax, az] = this.nodePos(i - DIRS[d][0], j - DIRS[d][1]);
    const [rx, rz] = rightOf(d);
    const [dx, dz] = DIRS[d];
    const L = this.lane;
    const hr = this.halfRoad;
    const p0 = [ax + dx * (hr + EXIT_OFFSET) + rx * L, az + dz * (hr + EXIT_OFFSET) + rz * L];
    const p2 = [bx - dx * (hr + STOP_OFFSET) + rx * L, bz - dz * (hr + STOP_OFFSET) + rz * L];
    const length = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
    return { type: 'straight', p0, p1: null, p2, length };
  }

  /** Curve through node (i, j) from direction d into direction d2. */
  makeTurn(i, j, d, d2) {
    const [bx, bz] = this.nodePos(i, j);
    const [rx, rz] = rightOf(d);
    const [rx2, rz2] = rightOf(d2);
    const L = this.lane;
    const hr = this.halfRoad;
    const p0 = [bx - DIRS[d][0] * (hr + STOP_OFFSET) + rx * L, bz - DIRS[d][1] * (hr + STOP_OFFSET) + rz * L];
    const p2 = [bx + DIRS[d2][0] * (hr + EXIT_OFFSET) + rx2 * L, bz + DIRS[d2][1] * (hr + EXIT_OFFSET) + rz2 * L];
    // Control point: where the two lane centre-lines cross (midpoint if straight on).
    const p1 = d === d2
      ? [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2]
      : [bx + (rx + rx2) * L, bz + (rz + rz2) * L];
    // Approximate arc length by sampling.
    let length = 0;
    let px = p0[0];
    let pz = p0[1];
    for (let k = 1; k <= 12; k++) {
      const t = k / 12;
      const x = bez(p0[0], p1[0], p2[0], t);
      const z = bez(p0[1], p1[1], p2[1], t);
      length += Math.hypot(x - px, z - pz);
      px = x;
      pz = z;
    }
    return { type: 'turn', p0, p1, p2, length };
  }

  // ------------------------------------------------------------------ parking
  /**
   * Parked cars along some kerbs, away from junctions. They are static
   * colliders for the player and are drawn by the traffic renderer.
   */
  _generateParking() {
    const L = this.layout;
    const rng = createRng(CONFIG.city.seed + 31);
    const hr = this.halfRoad;
    const shapes = ['sedan', 'hatchback', 'suv', 'pickup', 'taxi', 'tuktuk', 'sedan', 'hatchback', 'van', 'suv-luxury'];
    const { blocksX, blocksZ } = L.cfg;

    // Each road segment, each kerb. alongZ: road at x = roadX[i] between roadZ[j], roadZ[j+1].
    for (const alongZ of [true, false]) {
      const fixed = alongZ ? L.roadX : L.roadZ;
      const cross = alongZ ? L.roadZ : L.roadX;
      for (let i = 0; i < fixed.length; i++) {
        for (let j = 0; j < cross.length - 1; j++) {
          for (const side of [1, -1]) {
            if (!rng.chance(this.cfg.parkedChance)) continue;
            // Block on this kerb (must exist: no parking against the city wall).
            const bi = side > 0 ? i : i - 1;
            if (bi < 0 || bi >= (alongZ ? blocksX : blocksZ)) continue;
            const blockIndex = alongZ ? j * blocksX + bi : bi * blocksX + j;
            // Traffic on this kerb's lane drives in direction d with right(d) = side.
            const d = alongZ ? (side > 0 ? 3 : 1) : (side > 0 ? 0 : 2);
            const heading = Math.atan2(DIRS[d][0], DIRS[d][1]);
            const start = cross[j] + hr + 14;
            const end = cross[j + 1] - hr - 14;
            let at = start + rng.range(0, 8);
            const n = rng.int(1, 4);
            for (let k = 0; k < n && at < end; k++) {
              const shape = getVehicleShape(rng.pick(shapes));
              const c = at + shape.length / 2;
              if (c + shape.length / 2 > end) break;
              const lat = fixed[i] + side * (hr - shape.width / 2 - 0.25);
              const x = alongZ ? lat : c;
              const z = alongZ ? c : lat;
              const v = {
                id: this._uid++, parked: true, shape, x, z, heading,
                color: shape.type === 'taxi' ? 0xf2c419 : rng.pick(this.cfg.colors),
                speed: 0, braking: false, indicator: 0, wheelSpin: 0, render: null,
              };
              for (const cc of carCircles(x, z, heading, [], shape.circles)) L._addCircle(blockIndex, cc.x, cc.z, cc.r);
              this.parked.push(v);
              at += shape.length + rng.range(1.2, 6);
            }
          }
        }
      }
    }
    // Kerb spans that have parking (for street furniture placement later).
    L.parked = this.parked;
  }

  // ------------------------------------------------------------------ spawning
  _pickType() {
    let r = this.rng() * this._typeWeight;
    for (const [name, t] of this._typeTable) {
      r -= t.weight;
      if (r <= 0) return [name, t];
    }
    return this._typeTable[0];
  }

  /**
   * Try to place one vehicle at a random lane position whose distance from
   * (px, pz) is within [rMin, rMax]. `ahead` (optional {x, z} direction)
   * avoids spawning straight in front of the player's view.
   */
  _trySpawn(px, pz, rMin, rMax, ahead) {
    const rng = this.rng;
    const d = rng.int(0, 3);
    const i = rng.int(0, this.nx - 1);
    const j = rng.int(0, this.nz - 1);
    if (!this.hasNode(i - DIRS[d][0], j - DIRS[d][1])) return null;
    const seg = this.makeStraight(i, j, d);
    const t = rng.range(0.05, 0.7);
    const x = seg.p0[0] + (seg.p2[0] - seg.p0[0]) * t;
    const z = seg.p0[1] + (seg.p2[1] - seg.p0[1]) * t;
    const dist = Math.hypot(x - px, z - pz);
    if (dist < rMin || dist > rMax) return null;
    if (ahead && dist < rMax * 0.85) {
      const dot = ((x - px) * ahead.x + (z - pz) * ahead.z) / dist;
      if (dot > 0.6) return null; // would pop in right in front of the camera
    }
    for (const c of this.vehicles) {
      if (Math.abs(c.x - x) < 22 && Math.abs(c.z - z) < 22 && Math.hypot(c.x - x, c.z - z) < 10 + c.len) return null;
    }

    const [typeName, type] = this._pickType();
    const shape = getVehicleShape(rng.pick(type.shapes));
    const maxSpeed = rng.range(type.speed[0], type.speed[1]) * KMH;
    const v = {
      id: this._uid++,
      typeName, type, shape,
      len: shape.length, width: shape.width,
      i, j, dir: d,
      nextDir: this.chooseNext(i, j, d),
      seg, t,
      speed: maxSpeed * 0.6,
      maxSpeed,
      accel: type.accel,
      decel: type.decel,
      color: rng.pick(type.colors || this.cfg.colors),
      x, z, heading: Math.atan2(DIRS[d][0], DIRS[d][1]),
      waitTime: 0,
      bumped: 0,
      braking: false,
      hasReservation: false,
      wheelSpin: 0,
      indicator: 0,            // -1 left, 0 off, 1 right
      blinkPhase: rng(),
      blockedTime: 0,
      honkCooldown: 0,
      circles: [],
      render: null,
    };
    v.circles = carCircles(x, z, v.heading, v.circles, shape.circles);
    this.vehicles.push(v);
    this.onSpawn?.(v);
    return v;
  }

  _despawn(index) {
    const v = this.vehicles[index];
    this._leave(v, v.i, v.j);
    // Swap-remove keeps the array compact.
    const last = this.vehicles.pop();
    if (last !== v) this.vehicles[index] = last;
    this.onDespawn?.(v);
  }

  /** Fill the city around a point immediately (game start / restart). */
  populate(px, pz) {
    const [, rMax] = this.cfg.spawnRadius;
    for (let k = 0; k < 4000 && this.vehicles.length < this.target; k++) {
      this._trySpawn(px, pz, 25, rMax * this.radiusScale);
    }
  }

  clear() {
    while (this.vehicles.length) this._despawn(this.vehicles.length - 1);
    this.intersections.clear();
  }

  _manage(player) {
    if (!player) return;
    const [rMin, rMax] = this.cfg.spawnRadius;
    const far = this.cfg.despawnRadius * this.radiusScale;
    const target = this.target;
    // Recycle vehicles that are far away (or surplus after lowering density).
    for (let k = this.vehicles.length - 1; k >= 0; k--) {
      const v = this.vehicles[k];
      const d = Math.hypot(v.x - player.x, v.z - player.z);
      if (d > far || (this.vehicles.length > target && d > rMin)) this._despawn(k);
    }
    // Top up: a few attempts per frame keeps the cost flat.
    const ahead = { x: Math.sin(player.heading), z: Math.cos(player.heading) };
    let spawned = 0;
    for (let k = 0; k < 12 && this.vehicles.length < target && spawned < 2; k++) {
      if (this._trySpawn(player.x, player.z, rMin, rMax * this.radiusScale, ahead)) spawned++;
    }
  }

  // ------------------------------------------------------------ intersections
  _inter(i, j) {
    const key = i * 100 + j;
    let it = this.intersections.get(key);
    if (!it) {
      it = { occupants: new Map(), waiting: new Map() };
      this.intersections.set(key, it);
    }
    return it;
  }

  /** Is an oncoming vehicle about to cross the path of `car`'s left turn? */
  _oncomingTraffic(car) {
    const opp = (car.dir + 2) % 4;
    for (const o of this.vehicles) {
      if (o === car || o.i !== car.i || o.j !== car.j || o.dir !== opp) continue;
      const leftTurner = o.nextDir === (o.dir + 3) % 4;
      if (o.seg.type === 'turn') {
        if (!leftTurner) return true;
      } else {
        const remaining = (1 - o.t) * o.seg.length;
        if (remaining < 35 && o.speed > 1.5 && !leftTurner) return true;
      }
    }
    return false;
  }

  /**
   * "Don't block the box": is the start of our exit lane occupied by a slow
   * vehicle (or the player)? Entering would leave us stuck in the junction.
   */
  _exitBlocked(car) {
    const d2 = car.nextDir;
    const [dx, dz] = DIRS[d2];
    const [rx, rz] = rightOf(d2);
    const [bx, bz] = this.nodePos(car.i, car.j);
    const ex = bx + dx * (this.halfRoad + EXIT_OFFSET) + rx * this.lane;
    const ez = bz + dz * (this.halfRoad + EXIT_OFFSET) + rz * this.lane;
    const room = car.len + 4;
    const blocks = (x, z, speed, len) => {
      if (speed > 3) return false;
      const ox = x - ex;
      const oz = z - ez;
      const along = ox * dx + oz * dz - len / 2;
      return along > -3 && along < room && Math.abs(ox * dz - oz * dx) < 2.2;
    };
    for (const o of this.vehicles) {
      if (o !== car && blocks(o.x, o.z, o.speed, o.len)) return true;
    }
    const p = this._playerRef;
    return !!p && blocks(p.x, p.z, Math.hypot(p.vx, p.vz), 4.4);
  }

  /**
   * May this car enter its upcoming intersection now? `stopGap` is the
   * distance from its front bumper to the stop line.
   */
  _mayEnter(car, stopGap) {
    const it = this._inter(car.i, car.j);
    if (this.lights.isSignalized(car.i, car.j)) {
      const state = this.lights.carState(car.i, car.j, car.dir);
      const turningLeft = car.nextDir === (car.dir + 3) % 4;
      if (state !== GREEN) {
        // Go anyway only if too close to stop comfortably (the light changed
        // under us), or to clear a left turn that was waiting at the line.
        const cantStop = stopGap < (car.speed * car.speed) / (2 * car.decel * 1.6);
        const committed = (cantStop && (state === YELLOW || it.occupants.has(car.id)))
          || (state === YELLOW && turningLeft && stopGap < 2 && car.waitTime > 0.5);
        if (!committed) {
          it.occupants.delete(car.id);
          return false;
        }
        it.occupants.set(car.id, car.dir);
        return true;
      }
      if (it.occupants.has(car.id)) return true;
      // Cross traffic from the previous phase still clearing?
      for (const dir of it.occupants.values()) if (dir % 2 !== car.dir % 2) return false;
      if (turningLeft && this._oncomingTraffic(car)) return false;
      if (this._exitBlocked(car)) return false;
      it.occupants.set(car.id, car.dir);
      return true;
    }

    // Unsignalised: first come, first served.
    if (it.occupants.has(car.id)) return true;
    if (!it.waiting.has(car.id)) it.waiting.set(car.id, { dir: car.dir, since: performance.now() });
    const me = it.waiting.get(car.id);
    let olderRival = false;
    for (const [id, w] of it.waiting) {
      if (id !== car.id && w.dir !== car.dir && w.since < me.since) olderRival = true;
    }
    let ok = false;
    if (it.occupants.size === 0) ok = !olderRival;
    else {
      // Allow following through behind a car from the same approach.
      let sameDir = true;
      for (const dir of it.occupants.values()) if (dir !== car.dir) sameDir = false;
      ok = sameDir && !olderRival;
    }
    // Deadlock breaker.
    if (!ok && car.waitTime > this.cfg.intersectionWaitTimeout) ok = true;
    if (ok && this._exitBlocked(car)) ok = false;
    if (ok) {
      it.occupants.set(car.id, car.dir);
      it.waiting.delete(car.id);
    }
    return ok;
  }

  _leave(car, i, j) {
    const it = this.intersections.get(i * 100 + j);
    if (!it) return;
    it.occupants.delete(car.id);
    it.waiting.delete(car.id);
  }

  // ------------------------------------------------------------------- update
  /** player: { x, z, heading, speed } */
  update(dt, player) {
    if (dt <= 0) return;
    this._playerRef = player;
    this._manage(player);
    const cfg = this.cfg;
    const cars = this.vehicles;
    const peds = this.peds;
    const turnSpeed = cfg.turnSpeedKmh * KMH;

    for (const car of cars) {
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      const lookAhead = 12 + car.speed * 3;
      const halfLen = car.len / 2;

      // ---- Nearest obstacle ahead in our corridor: (bumper gap, its speed).
      let gap = Infinity;
      let leadSpeed = 0;
      let byPlayer = false;
      for (const other of cars) {
        if (other === car) continue;
        const dx = other.x - car.x;
        const dz = other.z - car.z;
        if (Math.abs(dx) > lookAhead + 6 || Math.abs(dz) > lookAhead + 6) continue;
        const along = dx * fx + dz * fz;
        if (along <= 0 || along > lookAhead + other.len / 2) continue;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (lateral > 2.3) continue;
        const ofx = Math.sin(other.heading);
        const ofz = Math.cos(other.heading);
        const headingDot = ofx * fx + ofz * fz;
        if (headingDot < 0.25) continue; // crossing / oncoming traffic is handled at junctions
        const g = along - halfLen - other.len / 2;
        if (g < gap) {
          gap = g;
          leadSpeed = other.speed * headingDot;
        }
      }
      if (player) {
        const dx = player.x - car.x;
        const dz = player.z - car.z;
        const along = dx * fx + dz * fz;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (along > 0 && along < lookAhead + 3 && lateral < 2.8) {
          const g = along - halfLen - 2.2;
          if (g < gap) {
            gap = g;
            leadSpeed = Math.max(0, player.vx * fx + player.vz * fz);
            byPlayer = true;
          }
        }
      }
      // Pedestrians on the road (crossing, fleeing, knocked down): stop for them.
      for (const p of peds) {
        if (!p.onRoad) continue;
        const dx = p.x - car.x;
        const dz = p.z - car.z;
        if (Math.abs(dx) > lookAhead || Math.abs(dz) > lookAhead) continue;
        const along = dx * fx + dz * fz;
        if (along <= 0) continue;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (lateral > car.width / 2 + 1.4) continue;
        const g = along - halfLen - 1.2;
        if (g < gap) {
          gap = g;
          leadSpeed = 0;
          byPlayer = false;
        }
      }
      // While turning, also keep the exit crosswalk clear.
      if (car.seg.type === 'turn') {
        const [ex, ez] = car.seg.p2;
        for (const p of peds) {
          if (!p.onRoad) continue;
          if (Math.abs(p.x - ex) < 4.5 && Math.abs(p.z - ez) < 4.5) {
            const g = Math.max((1 - car.t) * car.seg.length - 2, 0.1);
            if (g < gap) {
              gap = g;
              leadSpeed = 0;
            }
          }
        }
      }

      // ---- Desired speed (free road).
      let v0 = car.maxSpeed * this.speedScale;
      const turning = car.nextDir !== car.dir;
      if (car.seg.type === 'turn' && turning) v0 = turnSpeed;
      const remaining = (1 - car.t) * car.seg.length;
      let stopGap = Infinity;
      let waitingAtSignal = false;
      car.indicator = 0;
      if (car.seg.type === 'straight') {
        // Ease off before a turn.
        if (turning) v0 = Math.min(v0, Math.sqrt(turnSpeed * turnSpeed + 2 * car.decel * 0.6 * remaining));
        // Junction ahead: lights / reservation decide whether the stop line is an obstacle.
        if (remaining < 32) {
          const sg = remaining - Math.max(halfLen - SEDAN_HALF, 0);
          car.hasReservation = this._mayEnter(car, sg);
          if (!car.hasReservation) {
            stopGap = Math.max(sg, 0);
            waitingAtSignal = true;
            if (stopGap < 2) car.waitTime += dt;
          }
        }
        if (turning && remaining < cfg.indicatorDistance) car.indicator = car.nextDir === (car.dir + 1) % 4 ? 1 : -1;
      } else if (turning) {
        car.indicator = car.nextDir === (car.dir + 1) % 4 ? 1 : -1;
      }

      // ---- IDM acceleration.
      const a = car.accel;
      const b = car.decel;
      const v = car.speed;
      let acc = a * (1 - (v / Math.max(v0, 0.1)) ** 4);
      acc = Math.max(acc, -b); // slowing for a lower limit is comfortable
      let term = 0;
      const sqrtAB = 2 * Math.sqrt(a * b);
      if (gap < Infinity) {
        const s = Math.max(gap, 0.05);
        const sStar = cfg.minGap + Math.max(0, v * cfg.headway + (v * (v - leadSpeed)) / sqrtAB);
        term = Math.max(term, (sStar / s) ** 2);
      }
      if (stopGap < Infinity) {
        // IDM settles at s = minGap, i.e. ~1 m before the stop point.
        const s = Math.max(stopGap + cfg.minGap - 1, 0.05);
        const sStar = cfg.minGap + Math.max(0, v * cfg.headway * 0.5 + (v * v) / sqrtAB);
        term = Math.max(term, (sStar / s) ** 2);
      }
      acc -= a * term;
      acc = Math.max(acc, -cfg.emergencyBraking);
      if (car.bumped > 0) {
        car.bumped -= dt;
        acc = -cfg.emergencyBraking;
      }
      car.speed = Math.max(0, v + acc * dt);
      if (car.speed < 0.05 && acc < 0) car.speed = 0;
      car.braking = acc < -0.6 || (car.speed < 0.3 && (gap < 6 || stopGap < 3));

      // ---- Honk when the player blocks us.
      car.honkCooldown -= dt;
      if (byPlayer && car.speed < 0.6 && !waitingAtSignal && gap < 8) {
        car.blockedTime += dt;
        if (car.blockedTime > cfg.honkDelay && car.honkCooldown <= 0) {
          this.onHonk?.(car);
          car.honkCooldown = 4 + this.rng() * 3;
          car.blockedTime = 0;
        }
      } else {
        car.blockedTime = 0;
      }

      // ---- Advance along the segment (never past a stop line without permission).
      car.t += (car.speed * dt) / car.seg.length;
      if (stopGap < Infinity && car.t > 0.999) {
        car.t = 0.999;
        car.speed = 0;
      }
      if (car.t >= 1) this._nextSegment(car);

      const s = car.seg;
      let x;
      let z;
      let tx;
      let tz;
      if (s.type === 'straight') {
        x = s.p0[0] + (s.p2[0] - s.p0[0]) * car.t;
        z = s.p0[1] + (s.p2[1] - s.p0[1]) * car.t;
        tx = s.p2[0] - s.p0[0];
        tz = s.p2[1] - s.p0[1];
      } else {
        x = bez(s.p0[0], s.p1[0], s.p2[0], car.t);
        z = bez(s.p0[1], s.p1[1], s.p2[1], car.t);
        tx = bezD(s.p0[0], s.p1[0], s.p2[0], car.t);
        tz = bezD(s.p0[1], s.p1[1], s.p2[1], car.t);
      }
      car.x = x;
      car.z = z;
      car.heading = Math.atan2(tx, tz);
      car.wheelSpin += (car.speed / car.shape.wheelRadius) * dt;
      car.circles = carCircles(x, z, car.heading, car.circles, car.shape.circles);
    }
  }

  _nextSegment(car) {
    const overflow = (car.t - 1) * car.seg.length;
    if (car.seg.type === 'straight') {
      // Enter the intersection.
      car.seg = this.makeTurn(car.i, car.j, car.dir, car.nextDir);
      car.waitTime = 0;
    } else {
      // Leave the intersection onto the next road segment.
      this._leave(car, car.i, car.j);
      car.hasReservation = false;
      car.dir = car.nextDir;
      car.i += DIRS[car.dir][0];
      car.j += DIRS[car.dir][1];
      car.nextDir = this.chooseNext(car.i, car.j, car.dir);
      car.seg = this.makeStraight(car.i, car.j, car.dir);
    }
    car.t = Math.max(0, overflow) / car.seg.length;
  }

  /** Collision circles of all moving AI vehicles near a point (for the player's physics). */
  circlesNear(x, z, radius = 16) {
    const out = this._circles;
    out.length = 0;
    for (const car of this.vehicles) {
      if (Math.abs(car.x - x) > radius || Math.abs(car.z - z) > radius) continue;
      for (const c of car.circles) out.push({ x: c.x, z: c.z, r: c.r, owner: car });
    }
    return out;
  }
}

function bez(a, b, c, t) {
  const u = 1 - t;
  return u * u * a + 2 * u * t * b + t * t * c;
}

function bezD(a, b, c, t) {
  return 2 * (1 - t) * (b - a) + 2 * t * (c - b);
}
