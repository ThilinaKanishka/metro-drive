import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { damp, angleDiff, clamp } from './utils.js';

export const CAMERA_MODES = ['chase', 'cockpit', 'top', 'cinematic'];
const LABELS = { chase: 'Chase cam', cockpit: 'Cockpit', top: 'Top-down', cinematic: 'Cinematic' };

/**
 * Drives the main camera in one of four modes. Switch with next().
 *  chase     - smooth spring follow behind the car, speed-based FOV, avoids walls
 *  cockpit   - driver's eye, rigidly attached to the (rolling) car body
 *  top       - high overhead view, car always pointing up the screen
 *  cinematic - slow orbit around the car
 */
export class CameraRig {
  constructor(camera, car, layout) {
    this.camera = camera;
    this.car = car;
    this.layout = layout;
    this.modeIndex = 0;
    this.yaw = car.physics.heading;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.orbit = 0;
    this.shake = 0;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    this._colliders = [];
    this.snap();
  }

  get mode() {
    return CAMERA_MODES[this.modeIndex];
  }

  get label() {
    return LABELS[this.mode];
  }

  next() {
    this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
    this.car.model.setCockpit(this.mode === 'cockpit');
    this.camera.up.set(0, 1, 0);
    this.snap();
    return this.label;
  }

  /** Jump directly to the target (after resets / mode switches). */
  snap() {
    this.yaw = this.car.physics.heading;
    this.update(0, true);
  }

  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt, instant = false) {
    const cfg = CONFIG.camera;
    const p = this.car.physics;
    const cam = this.camera;
    const carPos = this.car.position;
    const speedRatio = clamp(p.speed / (CONFIG.car.topSpeedKmh / 3.6), 0, 1);
    let fov = cfg.fov;

    switch (this.mode) {
      case 'chase': {
        // Camera yaw lags the car heading (it stays behind the car even when reversing).
        this.yaw += angleDiff(this.yaw, p.heading) * (instant ? 1 : damp(3.2 + speedRatio * 3, dt));
        const fx = Math.sin(this.yaw);
        const fz = Math.cos(this.yaw);
        const dist = cfg.chaseDistance + speedRatio * 1.8;
        const desired = this._v.set(
          carPos.x - fx * dist,
          cfg.chaseHeight + speedRatio * 0.4,
          carPos.z - fz * dist,
        );
        this._avoidWalls(carPos, desired);
        if (instant) this.pos.copy(desired);
        else this.pos.lerp(desired, damp(cfg.chaseStiffness * 2, dt));
        this.look.set(carPos.x + fx * cfg.chaseLookAhead, 1.1, carPos.z + fz * cfg.chaseLookAhead);
        cam.position.copy(this.pos);
        cam.lookAt(this.look);
        fov += speedRatio * cfg.speedFovBoost;
        break;
      }
      case 'cockpit': {
        const body = this.car.model.body;
        body.updateWorldMatrix(true, false);
        const [ox, oy, oz] = cfg.cockpitOffset;
        cam.position.set(ox, oy, oz).applyMatrix4(body.matrixWorld);
        body.getWorldQuaternion(this._q);
        cam.quaternion.copy(this._q).multiply(this._flip);
        cam.rotateX(-0.06);
        cam.rotateY(-p.steer * 0.25); // glance into corners
        fov = 72 + speedRatio * 8;
        break;
      }
      case 'top': {
        const fx = Math.sin(p.heading);
        const fz = Math.cos(p.heading);
        const h = cfg.topHeight * (0.7 + speedRatio * 0.5);
        const desired = this._v.set(carPos.x + fx * 6, h, carPos.z + fz * 6);
        if (instant) this.pos.copy(desired);
        else this.pos.lerp(desired, damp(5, dt));
        this.yaw += angleDiff(this.yaw, p.heading) * (instant ? 1 : damp(3, dt));
        cam.position.copy(this.pos);
        cam.up.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        cam.lookAt(this.pos.x, 0, this.pos.z);
        fov = 50;
        break;
      }
      case 'cinematic': {
        this.orbit += dt * cfg.cinematicSpeed;
        const a = p.heading + Math.PI * 0.75 + this.orbit;
        const r = cfg.cinematicRadius + Math.sin(this.orbit * 0.7) * 5;
        const desired = this._v.set(
          carPos.x + Math.sin(a) * r,
          cfg.cinematicHeight + Math.sin(this.orbit * 0.5) * 3,
          carPos.z + Math.cos(a) * r,
        );
        this._avoidWalls(carPos, desired);
        if (instant) this.pos.copy(desired);
        else this.pos.lerp(desired, damp(2.5, dt));
        cam.position.copy(this.pos);
        cam.lookAt(carPos.x, 1.0, carPos.z);
        fov = 45;
        break;
      }
    }

    // Impact shake.
    if (this.shake > 0.001) {
      const s = this.shake * 0.25;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }

    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * (instant ? 1 : damp(4, dt));
      cam.updateProjectionMatrix();
    }
  }

  /** Pull the camera in toward the car if a building is in the way. */
  _avoidWalls(from, to) {
    const cols = this.layout.collidersNear(to.x, to.z, this._colliders);
    const steps = 8;
    let tMax = 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const z = from.z + (to.z - from.z) * t;
      for (const c of cols) {
        if (c.type !== 'box') continue;
        if (x > c.minX - 0.4 && x < c.maxX + 0.4 && z > c.minZ - 0.4 && z < c.maxZ + 0.4) {
          tMax = Math.min(tMax, (i - 1) / steps);
        }
      }
      if (tMax < 1) break;
    }
    if (tMax < 1) {
      to.x = from.x + (to.x - from.x) * Math.max(tMax, 0.25);
      to.z = from.z + (to.z - from.z) * Math.max(tMax, 0.25);
      to.y += (1 - tMax) * 2; // rise up a little when squeezed
    }
  }
}
