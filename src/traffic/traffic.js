import { CONFIG, KMH } from '../config.js';
import { createRng, clamp, approach } from '../core/utils.js';
import { carCircles } from '../vehicle/collision.js';

/**
 * AI traffic on the road grid.
 *
 * The road network is a grid graph: nodes are intersections (i, j), edges the
 * road segments between them. Each car drives in the right-hand lane of an
 * edge ("straight" segment), then through the intersection on a quadratic
 * Bezier ("turn" segment, which is also used for going straight on), picking
 * a random exit that is not a U-turn.
 *
 * Behaviour:
 *  - keeps its distance to any car (or the player) ahead in its lane
 *  - stops at the stop line until it gets a reservation for the intersection
 *  - slows down for turns
 */
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // +x, +z, -x, -z
const STOP_OFFSET = 6.4;  // centre of a waiting car, from intersection edge
const EXIT_OFFSET = 3.0;  // where the next straight begins after an intersection

// right(d) = (-dz, dx) for right-hand traffic.
const rightOf = (d) => [-DIRS[d][1], DIRS[d][0]];

export class Traffic {
  constructor(layout, count = CONFIG.traffic.count) {
    this.layout = layout;
    this.cfg = CONFIG.traffic;
    this.rng = createRng(CONFIG.city.seed + 7);
    this.cars = [];
    this.intersections = new Map();
    this.nx = layout.roadX.length;
    this.nz = layout.roadZ.length;
    this.lane = layout.laneOffset;
    this.halfRoad = layout.cfg.roadWidth / 2;
    this._circles = [];
    this.spawn(count);
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

  // ------------------------------------------------------------------ spawning
  spawn(count) {
    const rng = this.rng;
    const minGap = 14;
    let attempts = 0;
    while (this.cars.length < count && attempts++ < count * 50) {
      const d = rng.int(0, 3);
      const i = rng.int(0, this.nx - 1);
      const j = rng.int(0, this.nz - 1);
      // Edge must exist: previous node in grid.
      if (!this.hasNode(i - DIRS[d][0], j - DIRS[d][1])) continue;
      const seg = this.makeStraight(i, j, d);
      const t = rng.range(0.05, 0.8);
      const x = seg.p0[0] + (seg.p2[0] - seg.p0[0]) * t;
      const z = seg.p0[1] + (seg.p2[1] - seg.p0[1]) * t;
      // Keep clear of other cars and the player's spawn at the centre.
      if (this.cars.some((c) => Math.hypot(c.x - x, c.z - z) < minGap)) continue;
      if (Math.hypot(x, z) < 50) continue;

      const maxSpeed = rng.range(this.cfg.minSpeedKmh, this.cfg.maxSpeedKmh) * KMH;
      const car = {
        id: this.cars.length,
        i, j, dir: d,
        nextDir: this.chooseNext(i, j, d),
        seg, t,
        speed: maxSpeed * 0.6,
        maxSpeed,
        color: rng.pick(this.cfg.colors),
        x, z, heading: Math.atan2(DIRS[d][0], DIRS[d][1]),
        waitTime: 0,
        bumped: 0,
        braking: false,
        hasReservation: false,
        wheelSpin: 0,
        circles: [],
      };
      this.cars.push(car);
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

  /** May this car enter its upcoming intersection now? */
  _requestEntry(car) {
    const it = this._inter(car.i, car.j);
    if (it.occupants.has(car.id)) return true;
    if (!it.waiting.has(car.id)) it.waiting.set(car.id, { dir: car.dir, since: performance.now() });
    const me = it.waiting.get(car.id);

    // Someone from another direction has been waiting longer? Let them go first.
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

    if (ok) {
      it.occupants.set(car.id, car.dir);
      it.waiting.delete(car.id);
    }
    return ok;
  }

  _leave(car, i, j) {
    const it = this._inter(i, j);
    it.occupants.delete(car.id);
    it.waiting.delete(car.id);
  }

  // ------------------------------------------------------------------- update
  /** player: { x, z, heading, speed } */
  update(dt, player) {
    if (dt <= 0) return;
    const cfg = this.cfg;
    const cars = this.cars;

    for (const car of cars) {
      // ---- Look ahead for obstacles in our lane.
      const fx = Math.sin(car.heading);
      const fz = Math.cos(car.heading);
      let gap = Infinity;
      const lookAhead = cfg.safeDistance + car.speed * 1.4;
      for (const other of cars) {
        if (other === car) continue;
        const dx = other.x - car.x;
        const dz = other.z - car.z;
        const along = dx * fx + dz * fz;
        if (along <= 0 || along > lookAhead) continue;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (lateral > 2.2) continue;
        const headingDot = Math.sin(other.heading) * fx + Math.cos(other.heading) * fz;
        if (headingDot < 0.25) continue; // crossing / oncoming traffic is handled by reservations
        gap = Math.min(gap, along - 4.6);
      }
      if (player) {
        const dx = player.x - car.x;
        const dz = player.z - car.z;
        const along = dx * fx + dz * fz;
        const lateral = Math.abs(dx * fz - dz * fx);
        if (along > 0 && along < lookAhead && lateral < 2.8) gap = Math.min(gap, along - 4.6);
      }

      // ---- Target speed.
      let target = car.maxSpeed;
      if (car.seg.type === 'turn' && car.dir !== car.nextDir) target = cfg.turnSpeedKmh * KMH;
      const remaining = (1 - car.t) * car.seg.length;
      if (car.seg.type === 'straight') {
        // Slow before turning.
        if (car.nextDir !== car.dir && remaining < 22) {
          target = Math.min(target, cfg.turnSpeedKmh * KMH + remaining * 0.6);
        }
        // Stop line: ask for the intersection when close.
        if (remaining < 20 && !car.hasReservation) {
          car.hasReservation = this._requestEntry(car);
          if (!car.hasReservation) {
            target = Math.min(target, Math.sqrt(2 * 3 * Math.max(remaining - 0.3, 0)));
            if (remaining < 1.5) car.waitTime += dt;
          }
        }
      }
      if (gap < Infinity) {
        const free = clamp((gap - cfg.stopDistance) / cfg.safeDistance, 0, 1);
        target = Math.min(target, car.maxSpeed * free);
      }
      if (car.bumped > 0) {
        car.bumped -= dt;
        target = 0;
      }

      const rate = target < car.speed ? cfg.braking : cfg.acceleration;
      car.braking = target < car.speed - 0.5;
      car.speed = approach(car.speed, target, rate * dt);

      // ---- Advance along the segment.
      car.t += (car.speed * dt) / car.seg.length;
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
      car.wheelSpin += (car.speed / CONFIG.car.wheelRadius) * dt;
      car.circles = carCircles(x, z, car.heading, car.circles);
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

  /** Collision circles of all AI cars near a point (for the player's physics). */
  circlesNear(x, z, radius = 12) {
    const out = this._circles;
    out.length = 0;
    for (const car of this.cars) {
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
