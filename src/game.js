import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createRenderer, handleResize } from './core/renderer.js';
import { createScene } from './core/scene.js';
import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { CameraRig } from './core/cameraRig.js';
import { City } from './world/city.js';
import { DayNight } from './world/dayNight.js';
import { Car } from './vehicle/car.js';
import { Traffic } from './traffic/traffic.js';
import { TrafficRenderer } from './traffic/trafficRenderer.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { setupTouchControls } from './ui/touch.js';
import { EngineSound } from './audio/engineSound.js';

/**
 * Owns every subsystem and runs the frame:
 *   fixedUpdate (120 Hz): player physics + collisions
 *   update (per frame):   traffic AI, visuals, cameras, lighting, HUD, audio
 */
export class Game {
  constructor(container) {
    this.started = false;
    this.renderer = createRenderer(container);
    const { scene, camera } = createScene();
    this.scene = scene;
    this.camera = camera;
    this.input = new Input();

    // World
    this.city = new City(scene);
    this.layout = this.city.layout;
    this.dayNight = new DayNight(scene, this.renderer);

    // Player + traffic
    this.car = new Car(scene, this.input, this.layout);
    this.car.controls.enabled = false; // until Start is pressed
    this.traffic = new Traffic(this.layout, CONFIG.traffic.count);
    this.trafficRenderer = new TrafficRenderer(scene, this.traffic);

    // Camera, UI, audio
    this.cameraRig = new CameraRig(camera, this.car, this.layout);
    this.cameraRig.modeIndex = 3; // cinematic orbit behind the start screen
    this.cameraRig.snap();
    this.hud = new Hud();
    this.minimap = new Minimap(this.layout);
    this.audio = new EngineSound();
    setupTouchControls(this.input);

    this._bindActions();
    handleResize(this.renderer, camera);

    this._player = { x: 0, z: 0 };
    this.loop = new Loop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, frameDt) => this.update(dt, frameDt),
      render: () => this.renderer.render(scene, camera),
    });
    this.loop.start();
  }

  /** Called from the Start button (a user gesture, so audio may start). */
  start() {
    this.started = true;
    this.input.enabled = true;
    this.car.controls.enabled = true;
    this.audio.start();
    this.hud.show();
    this.cameraRig.modeIndex = 0;
    this.cameraRig.snap();
  }

  _bindActions() {
    const on = (a, fn) => this.input.on(a, fn);
    on('camera', () => this.hud.toast(this.cameraRig.next()));
    on('daynight', () => {
      this.dayNight.toggle();
      this.hud.toast(this.dayNight.night > 0.5 ? 'Sunrise…' : 'Nightfall…');
    });
    on('cycle', () => this.hud.toast(this.dayNight.toggleAuto() ? 'Time cycle on' : 'Time cycle paused'));
    on('mute', () => this.hud.toast(this.audio.toggleMute() ? 'Sound off' : 'Sound on'));
    on('reset', () => {
      this.car.resetToRoad();
      this.cameraRig.snap();
      this.hud.toast('Car reset');
    });
    on('pause', () => this.setPaused(!this.loop.paused));
    on('fps', () => this.hud.toggleFps());

    document.getElementById('pause').addEventListener('pointerdown', () => this.setPaused(false));
    // Auto-pause when the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.started) this.setPaused(true);
    });
  }

  setPaused(paused) {
    if (!this.started) return;
    this.loop.paused = paused;
    this.car.controls.enabled = !paused;
    document.getElementById('pause').classList.toggle('hidden', !paused);
    this.audio.setPaused(paused);
  }

  fixedUpdate(dt) {
    const p = this.car.physics;
    this.car.fixedUpdate(dt, this.traffic.circlesNear(p.x, p.z));
  }

  update(dt, frameDt) {
    const car = this.car;
    const p = car.physics;

    // AI traffic sees the player as an obstacle.
    this._player.x = p.x;
    this._player.z = p.z;
    this.traffic.update(dt, this._player);
    if (car.lastHit) {
      car.lastHit.bumped = 1.5; // AI car stops briefly after being hit
      car.lastHit = null;
    }

    const impact = car.consumeImpact();
    if (impact > 1.5) {
      this.audio.impact(impact);
      this.cameraRig.addShake(Math.min(impact / 15, 0.8));
    }

    // Lighting first (other systems read the night factor).
    const night = this.dayNight.night;
    const headlights = THREE.MathUtils.smoothstep(night, 0.3, 0.6);
    car.syncVisual(dt, headlights);
    this.cameraRig.update(dt);
    this.dayNight.update(dt, car.position, this.camera);
    this.city.update(night);
    this.trafficRenderer.update(night);

    if (this.started) {
      this.hud.update(frameDt, {
        speedKmh: p.speedKmh,
        rpm: p.rpm,
        gear: p.gearLabel,
        timeOfDay: this.dayNight.time,
        autoCycle: this.dayNight.autoCycle,
        cameraLabel: this.cameraRig.label,
        trafficCount: this.traffic.cars.length,
        muted: this.audio.muted,
      });
      this.minimap.update(p, this.traffic.cars);
      this.audio.update(p.rpm, p.throttle, p.skid, p.speed);
    }
  }
}
