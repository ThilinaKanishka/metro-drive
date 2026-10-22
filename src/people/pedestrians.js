import { CONFIG } from '../config.js';
import { createRng, clamp, angleDiff } from '../core/utils.js';

/**
 * Pedestrian simulation (rendering lives in pedestrianRenderer.js).
 *
 * People walk a sidewalk "lane" (a fixed distance in from the kerb) around
 * their block. At a corner they either carry on round the block or walk to
 * the kerb by the zebra crossing, wait for the walk signal and cross to the
 * next block. While crossing they are flagged `onRoad`, so AI traffic stops
 * for them.
 *
 * Other states:
 *  - idle:   standing at a shop front or bus stop (more of them at night)
 *  - flee:   jump back / run when a car is about to pass close or honks
 *  - fallen: knocked over by the player; lies down, then gets up again
 *
 * A fixed pool is kept alive in a ring around the player: people who end up
 * far away are respawned closer, out of the camera's view when possible.
 */
const WALK = 0;
const TO_KERB = 1;
const WAIT = 2;
const CROSS = 3;
const IDLE = 4;
const FLEE = 5;
const FALLEN = 6;
const GETUP = 7;
const BOARD = 8;
export const PED_STATE = { WALK, TO_KERB, WAIT, CROSS, IDLE, FLEE, FALLEN, GETUP, BOARD };

const KERB = 0.5;       // waiting / arrival point, distance in from the kerb
const ZEBRA = 1.8;      // crosswalk centre line, distance in from the block edge

export class Pedestrians {
  constructor(layout, lights) {
    this.layout = layout;
    this.lights = lights;
    this.cfg = CONFIG.pedestrians;
    this.rng = createRng(CONFIG.city.seed + 101);
    this.half = layout.cfg.blockSize / 2;
    this.sidewalk = layout.cfg.sidewalkWidth;
    this.list = [];
    this.count = this.cfg.count;
    this.night = 0;
    this.onHit = null;     // (ped, impactSpeed) => void
    this._uid = 0;
    this.idleSpots = layout.idleSpots || (layout.idleSpots = this._defaultIdleSpots());
  }

  /** Shop-front spots along every non-park block (street furniture adds bus stops later). */
  _defaultIdleSpots() {
    const spots = [];
    const rng = createRng(CONFIG.city.seed + 103);
    const h = this.half;
    this.layout.blocks.forEach((b, bi) => {
      if (b.park) return;
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let k = 0; k < 2; k++) {
          const t = rng.range(-h + 8, h - 8);
          const lane = this.sidewalk - 0.35;
          spots.push({
            x: b.cx + nx * (h - lane) + (nz !== 0 ? t : 0),
            z: b.cz + nz * (h - lane) + (nx !== 0 ? t : 0),
            yaw: Math.atan2(-nx, -nz), // facing the shop window
            kind: 'shop', block: bi,
          });
        }
      }
    });
    return spots;
  }

  // ------------------------------------------------------------ geometry
  _block(bi) {
    return this.layout.blocks[bi];
  }

  _blockIndex(ix, iz) {
    const { blocksX, blocksZ } = this.layout.cfg;
    if (ix < 0 || iz < 0 || ix >= blocksX || iz >= blocksZ) return -1;
    return iz * blocksX + ix;
  }

  _corner(bi, sx, sz, lane) {
    const b = this._block(bi);
    return [b.cx + sx * (this.half - lane), b.cz + sz * (this.half - lane)];
  }

  /** Keep a sidewalk pedestrian inside the sidewalk band of their block. */
  _clampToSidewalk(p) {
    let b = this._block(p.block);
    if (Math.abs(p.x - b.cx) > this.half + 1 || Math.abs(p.z - b.cz) > this.half + 1) {
      // Not near the home block (e.g. moved by script): adopt the block underfoot, if any.
      const { ix, iz } = this.layout.blockCoords(p.x, p.z);
      const bi = this._blockIndex(ix, iz);
      if (bi < 0) return;
      p.block = bi;
      b = this._block(bi);
      if (Math.abs(p.x - b.cx) > this.half || Math.abs(p.z - b.cz) > this.half) return;
    }
    const h = this.half - 0.25;
    const inner = this.half - this.sidewalk + 0.3;
    let dx = clamp(p.x - b.cx, -h, h);
    let dz = clamp(p.z - b.cz, -h, h);
    // Inside the inner square (plaza / buildings)? Push out to the nearer edge.
    if (Math.abs(dx) < inner && Math.abs(dz) < inner) {
      if (inner - Math.abs(dx) < inner - Math.abs(dz)) dx = Math.sign(dx || 1) * inner;
      else dz = Math.sign(dz || 1) * inner;
    }
    p.x = b.cx + dx;
    p.z = b.cz + dz;
  }

  _insideBlock(x, z) {
    const { ix, iz } = this.layout.blockCoords(x, z);
    const bi = this._blockIndex(ix, iz);
    if (bi < 0) return false;
    const b = this._block(bi);
    return Math.abs(x - b.cx) < this.half && Math.abs(z - b.cz) < this.half;
  }

  // ------------------------------------------------------------ spawning
  _newPed() {
    const c = this.cfg;
    const rng = this.rng;
    const child = rng.chance(0.08);
    return {
      id: this._uid++,
      x: 0, z: 0, yaw: 0,
      state: WALK, resume: WALK,
      block: 0, lane: 1, sx: 1, sz: 1, psx: 1, psz: 1,
      tx: 0, tz: 0, cross: null,
      speed: 0, walkSpeed: rng.range(c.walkSpeed[0], c.walkSpeed[1]) * (child ? 0.85 : 1),
      timer: 0, phase: rng() * 6.28, hop: 0, hopT: 0, headYaw: 0, look: rng() * 10,
      fall: 0, fallX: 0, fallZ: 1,
      fleeX: 0, fleeZ: 0,
      onRoad: false, visible: false, dist: 0,
      scale: child ? rng.range(0.6, 0.72) : rng.range(0.9, 1.07),
      skin: rng.pick(c.skin), hair: rng.pick(c.hair), top: rng.pick(c.tops), bottom: rng.pick(c.bottoms),
      longHair: rng.chance(0.35),
      hitCooldown: 0,
    };
  }

  /** Place p somewhere around (px, pz) at a distance in [rMin, rMax]. */
  _place(p, px, pz, rMin, rMax, ahead) {
    const rng = this.rng;
    const idleChance = this.night > 0.5 ? this.cfg.nightIdleChance : this.cfg.idleChance;
    for (let attempt = 0; attempt < 30; attempt++) {
      let x;
      let z;
      let bi;
      let idleSpot = null;
      if (rng.chance(idleChance) && this.idleSpots.length) {
        idleSpot = rng.pick(this.idleSpots);
        // At night prefer lit shop fronts.
        if (this.night > 0.5 && idleSpot.kind !== 'shop') idleSpot = rng.pick(this.idleSpots);
        x = idleSpot.x + rng.range(-0.8, 0.8);
        z = idleSpot.z + rng.range(-0.4, 0.4);
        bi = idleSpot.block;
      } else {
        const a = rng() * Math.PI * 2;
        const d = rng.range(rMin, rMax);
        const { ix, iz } = this.layout.blockCoords(px + Math.sin(a) * d, pz + Math.cos(a) * d);
        bi = this._blockIndex(ix, iz);
        if (bi < 0) continue;
        const b = this._block(bi);
        p.lane = rng.pick([rng.range(0.9, 1.3), rng.range(2.5, 3.0)]);
        // Random point on a random side of the block, in this lane.
        const side = rng.int(0, 3);
        const t = rng.range(-this.half + 3, this.half - 3);
        const off = this.half - p.lane;
        x = b.cx + (side === 0 ? off : side === 1 ? -off : t);
        z = b.cz + (side === 2 ? off : side === 3 ? -off : t);
      }
      const dist = Math.hypot(x - px, z - pz);
      if (dist < rMin || dist > rMax) continue;
      if (ahead && dist < 110 && ((x - px) * ahead.x + (z - pz) * ahead.z) / dist > 0.5) continue;

      p.x = x;
      p.z = z;
      p.block = bi;
      p.onRoad = false;
      p.fall = 0;
      p.hop = 0;
      p.cross = null;
      if (idleSpot) {
        p.state = IDLE;
        p.yaw = idleSpot.yaw + rng.range(-0.4, 0.4);
        p.timer = rng.range(20, 90);
        p.lane = 2.8;
      } else {
        this._pickCornerAhead(p);
        p.state = WALK;
      }
      return true;
    }
    return false;
  }

  /** Head for a random corner adjacent to the side the ped is on. */
  _pickCornerAhead(p) {
    const b = this._block(p.block);
    const dx = p.x - b.cx;
    const dz = p.z - b.cz;
    if (Math.abs(dx) > Math.abs(dz)) {
      p.sx = Math.sign(dx);
      p.sz = this.rng.chance(0.5) ? 1 : -1;
    } else {
      p.sz = Math.sign(dz);
      p.sx = this.rng.chance(0.5) ? 1 : -1;
    }
    p.psx = p.sx;
    p.psz = p.sz;
    [p.tx, p.tz] = this._corner(p.block, p.sx, p.sz, p.lane);
  }

  setCount(n) {
    this.count = n;
  }

  // ------------------------------------------------------------ taxi fares
  /** A waving passenger standing at (x, z) facing `yaw`. Never recycled. */
  spawnFare(x, z, yaw) {
    const p = this._newPed();
    p.x = x;
    p.z = z;
    p.yaw = yaw;
    p.scale = Math.max(p.scale, 0.92);
    p.fare = true;
    p.waving = true;
    p.state = IDLE;
    p.timer = Infinity;
    this._clampToSidewalk(p);
    this.list.unshift(p);
    return p;
  }

  /** The passenger walks to the car door and disappears inside. */
  boardFare(p, carX, carZ) {
    p.waving = false;
    p.state = BOARD;
    p.tx = carX;
    p.tz = carZ;
  }

  /** Passenger leaves (delivered or gave up) and becomes a normal pedestrian. */
  releaseFare(p, x = p.x, z = p.z) {
    p.fare = false;
    p.waving = false;
    p.hidden = false;
    p.x = x;
    p.z = z;
    p.onRoad = false;
    p.cross = null;
    this._clampToSidewalk(p);
    p.state = WALK;
    this._pickCornerAhead(p);
  }

  /** Fill the pool around a point (game start / restart). */
  populate(px, pz) {
    this.list.length = 0;
    const [, rMax] = this.cfg.spawnRadius;
    for (let k = 0; k < this.count; k++) {
      const p = this._newPed();
      if (this._place(p, px, pz, 4, rMax)) this.list.push(p);
    }
  }

  // ------------------------------------------------------------ decisions
  /** Arrived at corner (sx, sz): cross a street or keep walking round the block. */
  _atCorner(p) {
    const b = this._block(p.block);
    const options = [];
    const nxBlock = this._blockIndex(b.ix + p.sx, b.iz);
    const nzBlock = this._blockIndex(b.ix, b.iz + p.sz);
    const i = b.ix + (p.sx > 0 ? 1 : 0);
    const j = b.iz + (p.sz > 0 ? 1 : 0);
    const h = this.half;
    const jitter = this.rng.range(-0.7, 0.7);
    if (nxBlock >= 0) {
      const nb = this._block(nxBlock);
      const zc = b.cz + p.sz * (h - ZEBRA) + jitter;
      options.push({
        i, j, axis: 0, to: nxBlock, tsx: -p.sx, tsz: p.sz,
        wx: b.cx + p.sx * (h - KERB), wz: zc,
        fx: nb.cx - p.sx * (h - KERB), fz: zc,
      });
    }
    if (nzBlock >= 0) {
      const nb = this._block(nzBlock);
      const xc = b.cx + p.sx * (h - ZEBRA) + jitter;
      options.push({
        i, j, axis: 1, to: nzBlock, tsx: p.sx, tsz: -p.sz,
        wx: xc, wz: b.cz + p.sz * (h - KERB),
        fx: xc, fz: nb.cz - p.sz * (h - KERB),
      });
    }
    if (options.length && this.rng.chance(this.cfg.crossChance)) {
      p.cross = this.rng.pick(options);
      p.state = TO_KERB;
      p.tx = p.cross.wx;
      p.tz = p.cross.wz;
      return;
    }
    // Walk on to the next corner (not back where we came from).
    const a = [-p.sx, p.sz];
    const c = [p.sx, -p.sz];
    let next = this.rng.chance(0.5) ? a : c;
    if (next[0] === p.psx && next[1] === p.psz) next = next === a ? c : a;
    p.psx = p.sx;
    p.psz = p.sz;
    [p.sx, p.sz] = next;
    [p.tx, p.tz] = this._corner(p.block, p.sx, p.sz, p.lane);
  }

  _finishCrossing(p) {
    const cr = p.cross;
    p.block = cr.to;
    p.cross = null;
    p.onRoad = false;
    p.sx = cr.tsx;
    p.sz = cr.tsz;
    p.psx = p.sx;
    p.psz = p.sz;
    // Carry on along one of the two sides at this corner.
    if (this.rng.chance(0.5)) p.sx = -p.sx;
    else p.sz = -p.sz;
    [p.tx, p.tz] = this._corner(p.block, p.sx, p.sz, p.lane);
    p.state = WALK;
  }

  /** Back to normal behaviour after fleeing / getting up. */
  _resume(p) {
    if (p.fare) {
      // A waiting passenger goes back to waiting (and waving).
      p.state = IDLE;
      p.timer = Infinity;
      return;
    }
    if (p.cross && (p.resume === CROSS || p.onRoad)) {
      // Mid-crossing: hurry to whichever kerb is closer.
      const cr = p.cross;
      const dFar = Math.hypot(cr.fx - p.x, cr.fz - p.z);
      const dNear = Math.hypot(cr.wx - p.x, cr.wz - p.z);
      if (dNear < dFar) {
        p.state = TO_KERB;
        p.tx = cr.wx;
        p.tz = cr.wz;
      } else {
        p.state = CROSS;
        p.tx = cr.fx;
        p.tz = cr.fz;
      }
    } else if (p.resume === IDLE) {
      p.state = IDLE;
      p.timer = this.rng.range(5, 20);
    } else {
      p.cross = null;
      p.state = WALK;
      this._pickCornerAhead(p);
    }
  }

  // ------------------------------------------------------------ reactions
  _flee(p, dirX, dirZ, duration, hop = true) {
    if (p.state === FALLEN || p.state === GETUP) return;
    if (p.state !== FLEE) p.resume = p.state;
    p.state = FLEE;
    const l = Math.hypot(dirX, dirZ) || 1;
    p.fleeX = dirX / l;
    p.fleeZ = dirZ / l;
    p.timer = duration;
    if (hop && p.hopT <= 0) p.hopT = 0.35;
  }

  /** The player honked at (x, z) facing `heading`. */
  honk(x, z, heading) {
    const r = this.cfg.honkRadius;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    for (const p of this.list) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > r || p.state === FALLEN || p.state === GETUP) continue;
      const ahead = (dx * fx + dz * fz) / (d || 1);
      if (p.onRoad || (ahead > 0.3 && d < r * 0.7)) {
        // Jump out of the car's way: sideways relative to the car.
        const side = Math.sign(dx * fz - dz * fx) || 1;
        this._flee(p, fz * side, -fx * side, 0.9 + this.rng() * 0.5);
      } else if (p.hopT <= 0) {
        p.hopT = 0.3; // startled
        p.headYaw = clamp(angleDiff(p.yaw, Math.atan2(-dx, -dz)), -1.2, 1.2);
      }
    }
  }

  /**
   * Player interaction: scare people about to be passed closely, knock over
   * anyone the car touches. car: { x, z, vx, vz, heading, circles }
   */
  _reactToPlayer(p, car, speed) {
    const dx = p.x - car.x;
    const dz = p.z - car.z;
    if (Math.abs(dx) > 30 || Math.abs(dz) > 30) return;

    // Contact with the car body.
    if (p.state !== FALLEN && p.state !== GETUP && p.hitCooldown <= 0) {
      for (const c of car.circles) {
        const ex = p.x - c.x;
        const ez = p.z - c.z;
        const rr = c.r + 0.3;
        if (ex * ex + ez * ez < rr * rr) {
          if (speed > 1.6) {
            p.state = FALLEN;
            p.resume = p.onRoad ? CROSS : WALK;
            p.timer = this.cfg.fallTime;
            const l = speed || 1;
            p.fallX = car.vx / l;
            p.fallZ = car.vz / l;
            p.hitCooldown = this.cfg.fallTime + 3;
            // Shoved a little along the car's path.
            p.x += p.fallX * 0.6;
            p.z += p.fallZ * 0.6;
            this.onHit?.(p, speed);
          } else {
            const d = Math.hypot(ex, ez) || 1;
            this._flee(p, ex / d, ez / d, 0.6, false);
          }
          return;
        }
      }
    }
    if (p.state === FLEE || p.state === FALLEN || p.state === GETUP || speed < 3.5) return;

    // Predict the closest approach over the next ~1.3 s.
    const v2 = car.vx * car.vx + car.vz * car.vz;
    const tc = clamp((dx * car.vx + dz * car.vz) / v2, 0, 1.3);
    const cx = dx - car.vx * tc;
    const cz = dz - car.vz * tc;
    if (cx * cx + cz * cz < (this.cfg.scareDistance + 1) ** 2) {
      const side = Math.sign(dx * car.vz - dz * car.vx) || 1;
      // Perpendicular to the car's path, away from it.
      this._flee(p, car.vz * side, -car.vx * side, 0.8 + this.rng() * 0.6);
    }
  }

  // ------------------------------------------------------------ update
  /** player: { x, z, heading, vx, vz, circles }, eye: camera position */
  update(dt, player, eye, night = 0) {
    if (dt <= 0) return;
    this.night = night;
    const cfg = this.cfg;
    const [rMin, rMax] = cfg.spawnRadius;
    const speed = Math.hypot(player.vx, player.vz);
    const ahead = { x: Math.sin(player.heading), z: Math.cos(player.heading) };

    // Pool size follows the quality setting (fare passengers are kept).
    for (let k = this.list.length - 1; k >= 0 && this.list.length > this.count; k--) {
      if (!this.list[k].fare) this.list.splice(k, 1);
    }
    for (let k = 0; this.list.length < this.count && k < 3; k++) {
      const p = this._newPed();
      if (this._place(p, player.x, player.z, rMin, rMax, ahead)) this.list.push(p);
    }

    const draw2 = cfg.drawDistance ** 2;
    for (const p of this.list) {
      if (p.hidden) {
        p.visible = false;
        p.onRoad = false;
        continue;
      }
      const dpx = p.x - player.x;
      const dpz = p.z - player.z;
      if (dpx * dpx + dpz * dpz > cfg.despawnRadius ** 2 && p.state !== FALLEN && !p.fare) {
        this._place(p, player.x, player.z, rMin, rMax, ahead);
      }
      p.hitCooldown -= dt;
      this._reactToPlayer(p, player, speed);
      this._step(p, dt);
      const ex = p.x - eye.x;
      const ez = p.z - eye.z;
      p.dist = Math.sqrt(ex * ex + ez * ez);
      p.visible = p.dist * p.dist < draw2;
    }
  }

  _moveTo(p, speed, dt) {
    const dx = p.tx - p.x;
    const dz = p.tz - p.z;
    const d = Math.hypot(dx, dz);
    p.speed = speed;
    if (d < 0.25) return true;
    const step = Math.min(speed * dt, d);
    p.x += (dx / d) * step;
    p.z += (dz / d) * step;
    this._turnTo(p, Math.atan2(dx, dz), dt);
    return false;
  }

  _turnTo(p, yaw, dt) {
    p.yaw += angleDiff(p.yaw, yaw) * Math.min(1, dt * 8);
  }

  _step(p, dt) {
    const cfg = this.cfg;
    p.headYaw *= 1 - Math.min(1, dt * 1.5);
    if (p.hopT > 0) {
      p.hopT -= dt;
      p.hop = Math.max(0, Math.sin((1 - p.hopT / 0.35) * Math.PI)) * 0.32;
    } else p.hop = 0;

    switch (p.state) {
      case WALK:
        if (this._moveTo(p, p.walkSpeed, dt)) this._atCorner(p);
        // (Someone knocked into the road just walks back to the sidewalk.)
        if (!p.onRoad) this._clampToSidewalk(p);
        break;
      case TO_KERB:
        if (this._moveTo(p, p.walkSpeed, dt)) {
          p.state = WAIT;
          p.timer = 0;
        }
        if (!p.onRoad) this._clampToSidewalk(p);
        break;
      case WAIT: {
        p.speed = 0;
        const cr = p.cross;
        this._turnTo(p, Math.atan2(cr.fx - cr.wx, cr.fz - cr.wz), dt);
        p.timer += dt;
        // Glance around while waiting.
        p.look -= dt;
        if (p.look < 0) {
          p.look = 2 + this.rng() * 4;
          p.headYaw = this.rng.range(-0.9, 0.9);
        }
        if (this.lights.walkState(cr.i, cr.j, cr.axis) === 'walk' && p.timer > 0.4) {
          p.state = CROSS;
          p.tx = cr.fx;
          p.tz = cr.fz;
        }
        break;
      }
      case CROSS: {
        const cr = p.cross;
        // Hurry when the signal is ending.
        const sig = this.lights.walkState(cr.i, cr.j, cr.axis);
        const sp = sig === 'walk' ? p.walkSpeed : p.walkSpeed * 1.6;
        if (this._moveTo(p, sp, dt)) this._finishCrossing(p);
        break;
      }
      case IDLE:
        p.speed = 0;
        p.timer -= dt;
        p.look -= dt;
        if (p.look < 0) {
          p.look = 3 + this.rng() * 5;
          p.headYaw = this.rng.range(-0.8, 0.8);
        }
        if (p.timer < 0) {
          p.state = WALK;
          p.lane = 2.6;
          this._pickCornerAhead(p);
        }
        break;
      case FLEE: {
        p.speed = cfg.runSpeed;
        p.x += p.fleeX * cfg.runSpeed * dt;
        p.z += p.fleeZ * cfg.runSpeed * dt;
        this._turnTo(p, Math.atan2(p.fleeX, p.fleeZ), dt * 2);
        p.timer -= dt;
        // Sidewalk people stay on the sidewalk; others may dodge anywhere.
        if (!p.cross && !p.onRoad) this._clampToSidewalk(p);
        if (p.timer <= 0) this._resume(p);
        break;
      }
      case FALLEN:
        p.speed = 0;
        p.fall = Math.min(1, p.fall + dt * 3.2);
        p.timer -= dt;
        if (p.timer <= 0) {
          p.state = GETUP;
          p.timer = 0.9;
        }
        break;
      case BOARD:
        if (this._moveTo(p, p.walkSpeed * 1.3, dt) || Math.hypot(p.tx - p.x, p.tz - p.z) < 1.6) p.hidden = true;
        break;
      case GETUP:
        p.fall = Math.max(0, p.fall - dt * 1.3);
        p.timer -= dt;
        if (p.timer <= 0) {
          p.fall = 0;
          this._resume(p);
        }
        break;
      default:
        break;
    }
    p.onRoad = !this._insideBlock(p.x, p.z);
  }
}
