import { approach } from '../core/utils.js';

/**
 * Turns digital key presses into smooth analog driver inputs, the way a
 * real foot eases onto a pedal. Steering smoothing is done in the physics
 * (it depends on speed), pedals are ramped here.
 */
export class DriverControls {
  constructor(input) {
    this.input = input;
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = false;
    this.enabled = true;
    this.locked = false;   // race countdown: hold the car on the brake
  }

  update(dt) {
    let raw = this.enabled
      ? this.input.controls
      : { throttle: 0, brake: 0, steer: 0, handbrake: false };
    if (this.locked) raw = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    // Press quickly, release a bit faster (pedal ramps per second).
    this.throttle = approach(this.throttle, raw.throttle, (raw.throttle ? 4 : 8) * dt);
    this.brake = approach(this.brake, raw.brake, (raw.brake ? 6 : 10) * dt);
    this.steer = raw.steer;
    this.handbrake = raw.handbrake;
    return this;
  }
}
