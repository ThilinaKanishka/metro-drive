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
import { SkidMarks } from './vehicle/skidMarks.js';
import { Traffic } from './traffic/traffic.js';
import { TrafficRenderer } from './traffic/trafficRenderer.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { setupTouchControls } from './ui/touch.js';
import { EngineSound } from './audio/engineSound.js';
import { Garage } from './ui/garage.js';
import { loadPrefs, savePrefs } from './core/storage.js';

/**
 * Owns every subsystem and runs the frame:
 *   fixedUpdate (120 Hz): player physics + collisions
 *   update (per frame):   traffic AI, visuals, cameras, lighting, HUD, audio
 *
 * state: 'menu' (cinematic orbit behind the main menu), 'garage' (the garage
 * scene is rendered instead of the city), 'playing' or 'paused'.
 */
export class Game {
  constructor(container) {
    this.started = false;
    this.state = 'menu';
    this.prefs = loadPrefs();
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
    this.car = new Car(scene, this.input, this.layout, this.prefs.car, this.prefs.color);
    this.car.controls.enabled = false; // until Start is pressed
    this.skidMarks = new SkidMarks(scene);
    this.traffic = new Traffic(this.layout, CONFIG.traffic.count);
    this.trafficRenderer = new TrafficRenderer(scene, this.traffic);

    // Camera, UI, audio
    this.cameraRig = new CameraRig(camera, this.car, this.layout);
    this.cameraRig.modeIndex = 3; // cinematic orbit behind the start screen
    this.cameraRig.snap();
    this.hud = new Hud();
    this.minimap = new Minimap(this.layout);
    this.audio = new EngineSound();
    this.audio.setProfile(this.car.cfg.sound, this.car.cfg.redlineRpm);
    this.garage = new Garage(this.renderer, {
      onDrive: (id, color) => this._garageDrive(id, color),
      onBack: () => this._garageBack(),
    });
    setupTouchControls(this.input);

    this._bindActions();
    handleResize(this.renderer, camera, () => this.garage.resize());

    this._player = { x: 0, z: 0 };
    this.loop = new Loop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, frameDt) => this.update(dt, frameDt),
      render: () => {
        if (this.state === 'garage') this.garage.render();
        else this.renderer.render(scene, camera);
      },
    });
    this.loop.start();
  }

  /** Begin driving (called from a user gesture, so audio may start). */
  start() {
    this.started = true;
    this.state = 'playing';
    this.loop.paused = false;
    document.body.classList.add('playing');
    document.getElementById('start').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.input.enabled = true;
    this.car.controls.enabled = true;
    this.audio.start();
    this.audio.setPaused(false);
    this.hud.show();
    if (this.cameraRig.mode === 'cinematic') this.cameraRig.modeIndex = 0;
    this.cameraRig.snap();
  }

  /** Open the garage from the main menu ('menu') or the pause menu ('pause'). */
  openGarage(from) {
    this.garageFrom = from;
    this.state = 'garage';
    this.input.enabled = false;
    this.car.controls.enabled = false;
    this.loop.paused = from === 'pause';
    document.getElementById('start').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.audio.setPaused(true);
    this.garage.open(this.car.carId, this.car.color);
  }

  _garageDrive(id, color) {
    savePrefs({ car: id, color });
    if (id !== this.car.carId) {
      this.car.setVehicle(id, color);
      this.audio.setProfile(this.car.cfg.sound, this.car.cfg.redlineRpm);
      this.cameraRig.snap();
    } else {
      this.car.setColor(color);
    }
    if (this.garageFrom === 'pause') {
      this.state = 'paused';
      this.setPaused(false);
    } else {
      this.start();
    }
  }

  _garageBack() {
    if (this.garageFrom === 'pause') {
      this.state = 'paused';
      this.setPaused(true);
    } else {
      this.state = 'menu';
      document.getElementById('start').classList.remove('hidden');
    }
  }

  /** Pause menu -> Restart: back to the spawn point with a clean slate. */
  restart() {
    this.car.spawn();
    this.skidMarks.clear();
    this.cameraRig.snap();
    this.setPaused(false);
    this.hud.toast('Restarted');
  }

  /** Pause menu -> Main menu. */
  quitToMenu() {
    this.state = 'menu';
    this.loop.paused = false;
    this.input.enabled = false;
    this.car.controls.enabled = false;
    this.audio.setPaused(true);
    document.body.classList.remove('playing');
    document.getElementById('pause').classList.add('hidden');
    document.getElementById('start').classList.remove('hidden');
    this.hud.hide();
    if (this.cameraRig.mode === 'cockpit') this.car.setCockpit(false);
    this.cameraRig.modeIndex = 3;
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
      this.skidMarks.last[0] = this.skidMarks.last[1] = null;
      this.cameraRig.snap();
      this.hud.toast('Car reset');
    });
    on('pause', () => {
      if (this.state === 'playing') this.setPaused(true);
      else if (this.state === 'paused') this.setPaused(false);
    });
    on('fps', () => this.hud.toggleFps());

    const click = (id, fn) => document.getElementById(id).addEventListener('click', fn);
    click('pause-resume', () => this.setPaused(false));
    click('pause-garage', () => this.openGarage('pause'));
    click('pause-restart', () => this.restart());
    click('pause-quit', () => this.quitToMenu());
    // Auto-pause when the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.setPaused(true);
    });
  }

  setPaused(paused) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    this.state = paused ? 'paused' : 'playing';
    this.loop.paused = paused;
    this.input.enabled = true;
    this.car.controls.enabled = !paused;
    document.getElementById('pause').classList.toggle('hidden', !paused);
    this.audio.setPaused(paused);
  }

  fixedUpdate(dt) {
    const p = this.car.physics;
    this.car.fixedUpdate(dt, this.traffic.circlesNear(p.x, p.z));
  }

  update(dt, frameDt) {
    if (this.state === 'garage') {
      this.garage.update(frameDt);
      return;
    }
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
    if (dt > 0) this.skidMarks.update(p);
    this.cameraRig.update(dt);
    this.dayNight.update(dt, car.position, this.camera);
    this.city.update(night);
    this.trafficRenderer.update(night);

    if (this.state === 'playing' || this.state === 'paused') {
      this.hud.update(frameDt, {
        redline: car.cfg.redlineRpm,
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
