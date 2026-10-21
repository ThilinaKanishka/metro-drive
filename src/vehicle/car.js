import { CONFIG } from '../config.js';
import { createPlayerCar } from './carModel.js';
import { CarPhysics } from './carPhysics.js';
import { DriverControls } from './controls.js';
import { resolveCar } from './collision.js';
import { damp, clamp } from '../core/utils.js';

/**
 * Player car = visual model + physics body + driver input.
 * Physics runs in fixedUpdate; the visual model is synced every frame.
 */
export class Car {
  constructor(scene, input, layout) {
    this.layout = layout;
    this.model = createPlayerCar();
    scene.add(this.model.root);
    this.physics = new CarPhysics();
    this.controls = new DriverControls(input);
    this.roll = 0;
    this.pitch = 0;
    this.pendingImpact = 0;   // strongest collision since last read (audio / camera shake)
    this.lastHit = null;
    this._static = [];
    this.spawn();
  }

  /** Place the car on a road lane near the city centre. */
  spawn() {
    const L = this.layout;
    const midX = L.roadX[Math.floor(L.roadX.length / 2)];
    const z = L.roadZ[Math.floor(L.roadZ.length / 2)] + L.cell / 2;
    // Heading +z on a road along Z: right-hand lane is at x - laneOffset.
    this.physics.reset(midX - L.laneOffset, z, 0);
    this.syncVisual(0);
  }

  /** R key: drop the car back onto the nearest road, aligned with it. */
  resetToRoad() {
    const p = this.physics;
    const L = this.layout;
    const road = L.nearestRoad(p.x, p.z);
    const s = Math.sin(p.heading);
    const c = Math.cos(p.heading);
    let x = road.x;
    let z = road.z;
    let heading;
    if (road.axis === 'z') {
      const dir = c >= 0 ? 1 : -1;            // keep roughly the same direction
      heading = dir > 0 ? 0 : Math.PI;
      x += -dir * L.laneOffset;               // right-hand lane
    } else {
      const dir = s >= 0 ? 1 : -1;
      heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      z += dir * L.laneOffset;
    }
    p.reset(x, z, heading);
    this.syncVisual(0);
  }

  fixedUpdate(dt, dynamicCircles) {
    this.controls.update(dt);
    this.physics.step(dt, this.controls);
    const statics = this.layout.collidersNear(this.physics.x, this.physics.z, this._static);
    const { impact, hitOwner } = resolveCar(this.physics, statics, dynamicCircles);
    if (impact > this.pendingImpact) this.pendingImpact = impact;
    if (hitOwner) this.lastHit = hitOwner;
  }

  /** Per-frame visual sync: pose, body roll/pitch, wheels, lights. */
  syncVisual(dt, headlights = 0) {
    const p = this.physics;
    const c = CONFIG.car;
    const { root, body, wheels, steeringWheel } = this.model;
    root.position.set(p.x, 0, p.z);
    root.rotation.y = p.heading;

    // Body roll leans away from the turn; pitch dives under braking.
    // (+Z rotation lifts the left side, i.e. leans right during a left turn.)
    const targetRoll = clamp(p.latAccel * c.bodyRollFactor, -0.09, 0.09);
    const targetPitch = clamp(p.longAccel * c.bodyPitchFactor, -0.07, 0.07);
    const k = dt > 0 ? damp(c.bodySpring, dt) : 1;
    this.roll += (targetRoll - this.roll) * k;
    this.pitch += (targetPitch - this.pitch) * k;
    body.rotation.set(-this.pitch, 0, this.roll, 'YXZ');
    body.position.y = 0.02 + Math.abs(this.roll) * 0.2;

    for (const w of wheels) {
      w.spinner.rotation.x = p.wheelSpin;
      if (w.front) w.pivot.rotation.y = p.steer;
    }
    steeringWheel.rotation.z = -p.steer * 4;

    this.model.setLights(headlights, p.braking);
  }

  /** Returns and clears the strongest impact since the last call. */
  consumeImpact() {
    const v = this.pendingImpact;
    this.pendingImpact = 0;
    return v;
  }

  get position() {
    return this.model.root.position;
  }
}
