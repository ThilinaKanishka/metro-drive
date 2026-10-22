import { CONFIG, KMH } from '../config.js';
import { clamp, approach, damp } from '../core/utils.js';

const G = 9.81;
const RPM_PER_RADS = 60 / (2 * Math.PI);

/**
 * Arcade-sim car physics on a 2D plane (x, z) using a "bicycle" model:
 *  - longitudinal: engine torque curve through an automatic gearbox, brakes,
 *    engine braking, aero drag and rolling resistance
 *  - lateral: slip-angle tyre forces per axle, saturated by grip * axle load
 *  - weight transfer shifts load between axles under accel / braking
 *  - friction circle: rear drive force eats into rear lateral grip
 *  - handbrake drops rear grip -> drift
 *
 * Heading h: forward = (sin h, cos h); left = (cos h, -sin h).
 * Positive steer / yawRate = turning left.
 */
export class CarPhysics {
  constructor(cfg = CONFIG.car) {
    this.cfg = cfg;
    this.a = cfg.cgToFront;
    this.b = cfg.wheelBase - cfg.cgToFront;
    this.inertia = cfg.mass * (this.a * this.a + this.b * this.b) * 0.5 * cfg.inertiaScale;
    this.gripScale = 1;     // surface grip multiplier (wet roads < 1)
    this.reset(0, 0, 0);
  }

  reset(x, z, heading) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.vx = 0;
    this.vz = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.gear = 1;          // -1 = reverse, 1..n forward
    this.rpm = this.cfg.idleRpm;
    this.shiftTimer = 0;
    this.longAccel = 0;     // body-frame accelerations (smoothed, for weight transfer & visuals)
    this.latAccel = 0;
    this.wheelSpin = 0;     // accumulated wheel rotation angle
    this.skid = 0;          // 0..1 tyre squeal amount
    this.braking = false;
    this.throttle = 0;
    this.vLong = 0;
    this.vLat = 0;
  }

  get speed() {
    return Math.hypot(this.vx, this.vz);
  }

  get speedKmh() {
    return this.speed / KMH;
  }

  /** Text for the HUD gear indicator. */
  get gearLabel() {
    if (this.gear < 0) return 'R';
    if (this.speed < 0.3 && this.throttle === 0) return 'N';
    return String(this.gear);
  }

  /**
   * Advance the simulation by dt seconds.
   * controls: { throttle 0..1, brake 0..1, steer -1..1 (+left), handbrake bool }
   */
  step(dt, controls) {
    const c = this.cfg;
    const m = c.mass;
    const L = c.wheelBase;
    const a = this.a;
    const b = this.b;

    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    let vLong = this.vx * sinH + this.vz * cosH;
    let vLat = this.vx * cosH - this.vz * sinH;
    const speed = Math.hypot(vLong, vLat);

    // --- Drive direction: S brakes, then engages reverse once stopped -----
    let throttle;
    let brake;
    if (this.gear > 0) {
      throttle = controls.throttle;
      brake = controls.brake;
      if (controls.brake > 0 && !controls.throttle && vLong < 0.6) this.gear = -1;
    } else {
      throttle = controls.brake;
      brake = controls.throttle;
      if (controls.throttle > 0 && !controls.brake && vLong > -0.6) this.gear = 1;
    }
    this.throttle = throttle;
    this.braking = brake > 0 || (controls.handbrake && speed > 0.5);

    // --- Steering: speed-sensitive lock, smoothed --------------------------
    const steerFalloff = this.gear < 0 ? c.reverseSteerSpeedFactor : c.steerSpeedFactor;
    let maxSteer = c.maxSteerAngle / (1 + speed * steerFalloff);
    // Allow extra lock for counter-steering while the rear is sliding.
    const bodySlip = Math.abs(Math.atan2(vLat, Math.abs(vLong) + 0.5));
    if (speed > 4 && this.gear > 0) maxSteer = Math.max(maxSteer, Math.min(c.maxSteerAngle, bodySlip + 0.12));
    const targetSteer = controls.steer * maxSteer;
    const rate = Math.sign(targetSteer) !== Math.sign(this.steer) || targetSteer === 0 ? c.steerReturnRate : c.steerRate;
    this.steer = approach(this.steer, targetSteer, rate * dt);
    const delta = this.steer;

    // --- Engine / gearbox ----------------------------------------------------
    const ratio = this.gear > 0 ? c.gearRatios[this.gear - 1] : c.reverseRatio;
    const wheelRadS = Math.abs(vLong) / c.wheelRadius;
    let rpm = wheelRadS * ratio * c.finalDrive * RPM_PER_RADS;
    // Clutch slip at low speed lets the engine rev above wheel speed.
    const slipRpm = c.idleRpm + throttle * 2600;
    if (Math.abs(this.gear) === 1 && rpm < slipRpm) rpm = slipRpm;
    rpm = clamp(rpm, c.idleRpm, c.redlineRpm + 200);
    this.rpm += (rpm - this.rpm) * damp(18, dt);

    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.gear > 0 && this.shiftTimer === 0) {
      if (this.rpm > c.shiftUpRpm && this.gear < c.gearRatios.length) {
        this.gear++;
        this.shiftTimer = c.shiftTime;
      } else if (this.rpm < c.shiftDownRpm && this.gear > 1) {
        this.gear--;
        this.shiftTimer = c.shiftTime * 0.6;
      }
    }

    const torque = this._torqueAt(this.rpm);
    let driveForce = 0;
    if (this.shiftTimer === 0) {
      driveForce = throttle * torque * ratio * c.finalDrive * c.drivetrainEfficiency / c.wheelRadius;
    }
    // Speed limiters.
    if (this.gear > 0 && vLong > c.topSpeedKmh * KMH) driveForce = 0;
    if (this.gear < 0 && -vLong > c.reverseTopSpeedKmh * KMH) driveForce = 0;
    if (this.gear < 0) driveForce = -driveForce;

    // --- Axle loads with longitudinal weight transfer ------------------------
    const transfer = (m * this.longAccel * c.cgHeight) / L;
    const loadF = Math.max(m * G * (b / L) - transfer, m * G * 0.15);
    const loadR = Math.max(m * G * (a / L) + transfer, m * G * 0.15);
    const mu = c.tireGrip * this.gripScale;
    const gripF = mu * loadF;
    const gripR = mu * loadR * (controls.handbrake ? c.handbrakeRearGrip : c.rearGripBias);

    // Rear-wheel drive: traction is limited by rear grip; excess = wheelspin.
    const maxDrive = gripR * 0.98;
    let wheelspin = 0;
    if (Math.abs(driveForce) > maxDrive) {
      wheelspin = (Math.abs(driveForce) - maxDrive) / maxDrive;
      driveForce = Math.sign(driveForce) * maxDrive;
    }
    // Friction circle (softened): drive force reduces available lateral grip.
    const gripRLat = Math.sqrt(Math.max(gripR * gripR - (driveForce * c.frictionCircle) ** 2, (gripR * 0.25) ** 2));

    // --- Tyre slip angles & lateral forces ----------------------------------
    const soft = c.lowSpeedSlipSoftening;
    const cosD = Math.cos(delta);
    const sinD = Math.sin(delta);
    const frontLat = vLat + this.yawRate * a;
    // Velocity of the front contact patch expressed in the steered wheel frame.
    const fwLong = cosD * vLong + sinD * frontLat;
    const fwLat = -sinD * vLong + cosD * frontLat;
    const slipF = Math.atan2(fwLat, Math.abs(fwLong) + soft);
    const slipR = Math.atan2(vLat - this.yawRate * b, Math.abs(vLong) + soft);
    const fyF = clamp(-c.corneringStiffnessFront * slipF, -gripF, gripF);
    const fyR = clamp(-c.corneringStiffnessRear * slipR, -gripRLat, gripRLat);

    // --- Longitudinal resistances (always oppose motion) --------------------
    let resist = c.rollingResistance * Math.abs(vLong) + c.dragCoefficient * vLong * vLong;
    resist += brake * c.brakeForce;
    if (controls.handbrake) resist += c.handbrakeForce;
    if (throttle === 0 && this.gear > 0) {
      resist += c.engineBraking * clamp((this.rpm - c.idleRpm) / (c.redlineRpm - c.idleRpm), 0, 1);
    }

    // --- Sum forces in the body frame, integrate in world frame -------------
    const fxBody = driveForce - fyF * sinD;
    const fyBody = fyF * cosD + fyR;
    const torqueYaw = a * fyF * cosD - b * fyR - c.yawDamping * this.yawRate;

    const axBody = fxBody / m;
    const ayBody = fyBody / m;
    this.vx += (sinH * axBody + cosH * ayBody) * dt;
    this.vz += (cosH * axBody - sinH * ayBody) * dt;
    this.yawRate += (torqueYaw / this.inertia) * dt;

    // Apply resistance in the body frame, never letting it reverse the motion.
    vLong = this.vx * sinH + this.vz * cosH;
    vLat = this.vx * cosH - this.vz * sinH;
    const dv = (resist / m) * dt;
    const vLongBefore = vLong;
    vLong = Math.abs(vLong) <= dv ? 0 : vLong - Math.sign(vLong) * dv;
    this.vx = sinH * vLong + cosH * vLat;
    this.vz = cosH * vLong - sinH * vLat;

    // Parking: settle completely when nearly stopped with no input.
    if (Math.abs(vLong) < 0.15 && Math.abs(vLat) < 0.3 && throttle === 0) {
      const k = damp(8, dt);
      this.vx -= this.vx * k;
      this.vz -= this.vz * k;
      this.yawRate -= this.yawRate * k;
    }

    // --- Integrate pose ------------------------------------------------------
    this.heading += this.yawRate * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Smoothed body-frame acceleration for weight transfer and body motion.
    const longA = axBody + (vLong - vLongBefore) / dt;
    this.longAccel += (longA - this.longAccel) * damp(10, dt);
    this.latAccel += (ayBody - this.latAccel) * damp(10, dt);

    this.vLong = vLong;
    this.vLat = vLat;
    this.wheelSpin += (vLong / c.wheelRadius) * dt * (wheelspin > 0 ? 1.6 : 1);

    // Tyre squeal: sliding tyres, wheelspin, or a locked handbrake at speed.
    const slide = Math.max(Math.abs(slipF), Math.abs(slipR)) - 0.12;
    const speedFactor = clamp(speed / 6, 0, 1);
    let skid = clamp(slide * 3.5, 0, 1) * speedFactor;
    skid = Math.max(skid, clamp(wheelspin * 0.8, 0, 1) * clamp(1 - speed / 20, 0, 1));
    if (brake > 0.5 && speed > 12 && Math.abs(this.longAccel) > 8.5) skid = Math.max(skid, 0.5);
    this.skid += (skid - this.skid) * damp(12, dt);
  }

  /** Simple torque curve: rises to peak, falls off toward redline, limiter above. */
  _torqueAt(rpm) {
    const c = this.cfg;
    if (rpm >= c.redlineRpm) return 0;
    if (rpm < c.peakTorqueRpm) {
      return c.peakTorque * (0.62 + 0.38 * (rpm - c.idleRpm) / (c.peakTorqueRpm - c.idleRpm));
    }
    const t = (rpm - c.peakTorqueRpm) / (c.redlineRpm - c.peakTorqueRpm);
    return c.peakTorque * (1 - 0.35 * t * t);
  }

  /** Apply an impulse-style velocity change from a collision. */
  applyImpact(nx, nz, depth, contactForward, contactLeft) {
    const c = this.cfg;
    // Push out of the obstacle.
    this.x += nx * depth;
    this.z += nz * depth;
    const vn = this.vx * nx + this.vz * nz;
    if (vn >= 0) return 0;

    // Reflect normal component with restitution, scrub some tangential speed.
    const j = -(1 + c.collisionRestitution) * vn;
    this.vx += nx * j;
    this.vz += nz * j;
    const keep = 1 - (1 - c.collisionFriction) * Math.min(1, -vn / 8);
    this.vx *= keep;
    this.vz *= keep;

    // Off-centre hits make the car spin a little. r x J (y component).
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const rx = sinH * contactForward + cosH * contactLeft;
    const rz = cosH * contactForward - sinH * contactLeft;
    const angImpulse = rz * nx * j - rx * nz * j;
    this.yawRate += (angImpulse * c.mass) / this.inertia * 0.35;
    this.yawRate *= 0.8;
    return -vn;
  }
}
