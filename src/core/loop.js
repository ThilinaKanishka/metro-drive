import { CONFIG } from '../config.js';

/**
 * Game loop with a fixed-timestep physics update and a variable-rate render.
 * `fixedUpdate(dt)` runs 0..N times per frame at CONFIG.physics.fixedStep,
 * `update(dt, alpha)` runs once per frame (animation, cameras, HUD).
 */
export class Loop {
  constructor({ fixedUpdate, update, render }) {
    this.fixedUpdate = fixedUpdate;
    this.update = update;
    this.render = render;
    this.accumulator = 0;
    this.last = 0;
    this.running = false;
    this.paused = false;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._tick);
  }

  _tick(now) {
    if (!this.running) return;
    requestAnimationFrame(this._tick);

    // Clamp frame time so a background tab doesn't explode the simulation.
    const frameDt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;

    const step = CONFIG.physics.fixedStep;
    if (!this.paused) {
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= step && steps < CONFIG.physics.maxSubSteps) {
        this.fixedUpdate(step);
        this.accumulator -= step;
        steps++;
      }
      if (steps === CONFIG.physics.maxSubSteps) this.accumulator = 0;
    }
    this.update(this.paused ? 0 : frameDt, frameDt);
    this.render();
  }
}
