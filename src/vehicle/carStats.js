import { CONFIG, KMH, makeCarConfig } from '../config.js';
import { CarPhysics } from './carPhysics.js';
import { clamp } from '../core/utils.js';

/**
 * Garage stats measured by actually running each car's physics offline
 * (a few thousand 120 Hz steps, cached), so the bars always match how the
 * car drives:
 *  - 0-100 km/h time (or 0-60 for slow cars) and reachable top speed
 *  - braking distance from 80 km/h
 *  - steady-state lateral grip on a constant-radius turn
 */
const cache = new Map();
const DT = 1 / 120;

function drive(phys, controls, seconds, until) {
  for (let t = 0; t < seconds; t += DT) {
    phys.step(DT, controls);
    if (until && until(phys, t)) return t;
  }
  return seconds;
}

export function computeCarStats(id) {
  if (cache.has(id)) return cache.get(id);
  const cfg = makeCarConfig(id);
  const p = new CarPhysics(cfg);
  const full = { throttle: 1, brake: 0, steer: 0, handbrake: false };

  // Acceleration: time to 100 km/h (or 60 for cars that can't get to 100 quickly).
  const target = cfg.topSpeedKmh > 120 ? 100 : 50;
  const accelTime = drive(p, full, 30, (ph) => ph.speedKmh >= target);
  // Keep going for the reachable top speed.
  drive(p, full, 60);
  const topSpeed = p.speedKmh;

  // Braking from 80 km/h.
  p.reset(0, 0, 0);
  p.vz = 80 * KMH;
  const z0 = p.z;
  drive(p, { throttle: 0, brake: 1, steer: 0, handbrake: false }, 20, (ph) => ph.speed < 0.2);
  const brakeDist = p.z - z0;

  // Handling: full lock at 60 km/h (or 85% of top speed) and measure the
  // steady lateral acceleration - this is grip-limited, so it ranks the cars.
  const v = Math.min(60, topSpeed * 0.85) * KMH;
  p.reset(0, 0, 0);
  p.vz = v;
  let lat = 0;
  let n = 0;
  for (let t = 0; t < 4; t += DT) {
    // Cruise control on vLong so the measurement is at a fixed speed.
    const th = p.vLong < v ? 0.6 : 0;
    p.step(DT, { throttle: th, brake: 0, steer: 1, handbrake: false });
    if (t > 2) {
      lat += Math.abs(p.yawRate * p.speed);
      n++;
    }
  }
  const latG = lat / n / 9.81;

  const stats = {
    accelTime, accelTarget: target, topSpeed, brakeDist, latG,
    mass: cfg.mass,
    bars: {
      speed: clamp(topSpeed / 280, 0.05, 1),
      accel: clamp(1 - (accelTime * (100 / target) - 3) / 14, 0.05, 1),
      handling: clamp((latG - 0.55) / 0.75, 0.05, 1),
      braking: clamp(1 - (brakeDist - 18) / 30, 0.05, 1),
    },
  };
  cache.set(id, stats);
  return stats;
}

export const CAR_IDS = Object.keys(CONFIG.cars);
