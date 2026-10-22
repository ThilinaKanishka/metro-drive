import { CONFIG, makeCarConfig } from '../config.js';
import { createPlayerCar } from './carModel.js';
import { getVehicleShape } from './vehicleShapes.js';
import { CarPhysics } from './carPhysics.js';
import { DriverControls } from './controls.js';
import { resolveCar } from './collision.js';
import { damp, clamp } from '../core/utils.js';

/**
 * Player car = visual model + physics body + driver input.
 * Physics runs in fixedUpdate; the visual model is synced every frame.
 * setVehicle() swaps the car (garage) while keeping its position.
 */
export class Car {
  constructor(scene, input, layout, carId = CONFIG.player.car, color = CONFIG.player.color) {
    this.scene = scene;
    this.layout = layout;
    this.controls = new DriverControls(input);
    this.roll = 0;
    this.pitch = 0;
    this.pendingImpact = 0;   // strongest collision since last read (audio / camera shake)
    this.lastHit = null;
    this.indicator = 0;       // -1 left, 0 off, 1 right, 2 hazards
    this.blinkTime = 0;
    this._static = [];
    this.model = null;
    this.setVehicle(carId, color);
    this.spawn();
  }

  /** Swap to another car from the catalogue (keeps pose). */
  setVehicle(carId, color) {
    const cfg = makeCarConfig(carId);
    this.shape = getVehicleShape(cfg.shape);
    cfg.length = this.shape.length;
    cfg.width = this.shape.width;
    cfg.circles = this.shape.circles;
    this.cfg = cfg;
    this.carId = cfg.id;
    this.color = color;

    const old = this.physics;
    this.physics = new CarPhysics(cfg);
    if (old) this.physics.reset(old.x, old.z, old.heading);

    const cockpit = this.model?.cockpitOn ?? false;
    this.model?.dispose();
    this.model = createPlayerCar(cfg.shape, color);
    this.scene.add(this.model.root);
    if (cockpit) this.setCockpit(true);
    this.onModelChange?.(this.model);
    this.syncVisual(0);
  }

  setColor(color) {
    this.color = color;
    this.model.setColor(color);
  }

  setCockpit(on) {
    this.model.cockpitOn = on;
    this.model.setCockpit(on);
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

  fixedUpdate(dt, dynamicCircles, gripScale = 1) {
    this.controls.update(dt);
    this.physics.gripScale = gripScale;
    this.physics.step(dt, this.controls);
    const statics = this.layout.collidersNear(this.physics.x, this.physics.z, this._static);
    const { impact, hitOwner, hitX, hitZ } = resolveCar(this.physics, statics, dynamicCircles);
    if (impact > this.pendingImpact) {
      this.pendingImpact = impact;
      this.impactPoint = { x: hitX, z: hitZ };
    }
    if (hitOwner) this.lastHit = hitOwner;
  }

  /** Q / E: toggle the left / right indicator. */
  toggleIndicator(side) {
    this.indicator = this.indicator === side ? 0 : side;
    this.blinkTime = 0;
    return this.indicator;
  }

  /** Per-frame visual sync: pose, body roll/pitch, wheels, lights. */
  syncVisual(dt, headlights = 0) {
    const p = this.physics;
    const c = this.cfg;
    const { root, body, wheels, steeringWheel } = this.model;
    root.position.set(p.x, 0, p.z);
    root.rotation.y = p.heading;

    // Body roll leans away from the turn; pitch dives under braking.
    // (+Z rotation lifts the left side, i.e. leans right during a left turn.)
    const tall = c.cgHeight / CONFIG.car.cgHeight; // tall cars lean more
    const targetRoll = clamp(p.latAccel * c.bodyRollFactor * tall, -0.1, 0.1);
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

    // Indicators blink at ~1.5 Hz.
    this.blinkTime += dt;
    const blink = this.indicator !== 0 && (this.blinkTime % 0.66) < 0.36;
    this.blinkOn = blink;
    const left = blink && (this.indicator === -1 || this.indicator === 2);
    const right = blink && (this.indicator === 1 || this.indicator === 2);
    this.model.setLights(headlights, p.braking, p.gear < 0, left, right);
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
