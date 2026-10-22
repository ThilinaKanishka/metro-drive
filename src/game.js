import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createRenderer, handleResize } from './core/renderer.js';
import { createScene } from './core/scene.js';
import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { CameraRig } from './core/cameraRig.js';
import { City } from './world/city.js';
import { facadeUniforms } from './world/buildings.js';
import { windUniforms } from './world/trees.js';
import { DayNight } from './world/dayNight.js';
import { Car } from './vehicle/car.js';
import { SkidMarks } from './vehicle/skidMarks.js';
import { Traffic } from './traffic/traffic.js';
import { TrafficRenderer } from './traffic/trafficRenderer.js';
import { TrafficLights } from './traffic/trafficLights.js';
import { Pedestrians } from './people/pedestrians.js';
import { PedestrianRenderer } from './people/pedestrianRenderer.js';
import { carCircles } from './vehicle/collision.js';
import { Score } from './gameplay/score.js';
import { Missions, MODES } from './gameplay/missions.js';
import { Weather } from './world/weather.js';
import { ReflectionEnvironment } from './world/environment.js';
import { StreetProps } from './world/props.js';
import { CityAudio } from './audio/cityAudio.js';
import { SettingsMenu } from './ui/settings.js';
import { PostFX } from './core/post.js';
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
    this.lights = new TrafficLights(scene, this.layout);
    this.traffic = new Traffic(this.layout, this.lights);
    this.traffic.setDensity(this.prefs.density ?? CONFIG.traffic.defaultDensity);
    this.traffic.populate(this.car.physics.x, this.car.physics.z);
    this.trafficRenderer = new TrafficRenderer(scene, this.traffic);
    this.traffic.onHonk = (v) => this._aiHonk(v);
    this.props = new StreetProps(scene, this.layout); // after parking, before pedestrians (idle spots)
    this.peds = new Pedestrians(this.layout, this.lights);
    this.peds.populate(this.car.physics.x, this.car.physics.z);
    this.pedRenderer = new PedestrianRenderer(scene, this.peds);
    this.traffic.peds = this.peds.list;
    this.peds.onHit = (ped, speed) => this._pedestrianHit(ped, speed);

    // Camera, UI, audio
    this.cameraRig = new CameraRig(camera, this.car, this.layout);
    this.cameraRig.modeIndex = 3; // cinematic orbit behind the start screen
    this.cameraRig.snap();
    this.hud = new Hud();
    this.minimap = new Minimap(this.layout);
    this.audio = new EngineSound();
    this.audio.setProfile(this.car.cfg.sound, this.car.cfg.redlineRpm);
    this.cityAudio = new CityAudio(this.audio);

    // Weather + reflections (car paint / glass, wet roads).
    const roadMats = this.city.roads.userData.materials;
    this.weather = new Weather(scene, camera, roadMats);
    // Sky env map = scene.environment (IBL + reflections for every PBR
    // material); wet roads get it explicitly so the weather can drive them.
    this.env = new ReflectionEnvironment(this.renderer, scene, this.dayNight.skySystem);
    for (const m of Object.values(roadMats)) {
      m.userData.envManual = true;
      this.env.add(m);
    }
    this.env.add(this.trafficRenderer.materials.paint);
    this.env.add(this.trafficRenderer.materials.glass);
    this._carEnvMats = [];
    this.car.onModelChange = (model) => this._onCarModel(model);
    this._onCarModel(this.car.model);
    this.garage = new Garage(this.renderer, {
      onDrive: (id, color) => this._garageDrive(id, color),
      onBack: () => this._garageBack(),
    });
    setupTouchControls(this.input);

    // Gameplay: score / money and the selected mission mode.
    this.score = new Score(this.hud);
    this.missions = new Missions({
      scene, layout: this.layout, peds: this.peds, car: this.car, score: this.score, hud: this.hud,
    });
    this.missions.onTeleport = () => {
      this.skidMarks.clear();
      this.cameraRig.snap();
    };
    this.mode = this.prefs.mode in MODES ? this.prefs.mode : 'free';
    this._modeStarted = null;
    this.time = 0;

    this.post = new PostFX(this.renderer, scene, camera);
    this._sunGrid = this._buildHeightGrid();
    this._sunVis = 1;

    this._bindActions();
    this._resize = handleResize(this.renderer, camera, (w, h) => {
      this.garage.resize();
      this.post.setSize(w, h);
    });

    // Settings (persisted); touch devices default to Low graphics.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    this.settings = {
      quality: touch ? 'low' : 'medium',
      volume: CONFIG.audio.masterVolume,
      density: this.prefs.density ?? CONFIG.traffic.defaultDensity,
      time: 'auto',
      weather: this.prefs.weather ?? CONFIG.weather.default,
      ...this.prefs.settings,
    };
    this.settingsMenu = new SettingsMenu({
      onChange: (patch) => this.applySettings(patch),
      onClose: () => this._closeSettings(),
    });
    this.applySettings({}, true);

    this._player = { x: 0, z: 0, heading: 0, vx: 0, vz: 0, circles: [] };
    this.loop = new Loop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, frameDt) => this.update(dt, frameDt),
      render: (frameDt) => this._render(frameDt),
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
    // (Re)start the mission when entering play or after changing mode.
    if (this._modeStarted !== this.mode) {
      this._modeStarted = this.mode;
      this.score.resetSession();
      this.missions.setMode(this.mode);
    }
    this.cameraRig.snap();
  }

  /** A (new) player car model: reflections and headlight mode. */
  _onCarModel(model) {
    for (const m of this._carEnvMats) this.env.remove(m);
    this._carEnvMats = model.reflective;
    for (const m of this._carEnvMats) this.env.add(m);
    model.setHeadlightMode(this.headlightMode ?? 'decal');
    model.setHeadlightShadow(!!this.headlightShadows);
  }

  /**
   * Compile shaders for both headlight states (light count changes the
   * programs) so turning the lights on at dusk doesn't stall.
   */
  _warmUpShaders() {
    const m = this.car.model;
    m.forceBeams(true);
    this.renderer.compile(this.scene, this.camera);
    m.forceBeams(false);
    this.renderer.compile(this.scene, this.camera);
  }

  /** Draw the frame: garage scene, post-processing chain, or plain render (Low). */
  _render(frameDt) {
    const r = this.renderer;
    if (this.state === 'garage') {
      // The garage is lit for direct ACES output.
      const tm = r.toneMapping;
      const ex = r.toneMappingExposure;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1;
      this.garage.render();
      r.toneMapping = tm;
      r.toneMappingExposure = ex;
    } else if (this.post.enabled) {
      this.post.render(frameDt);
    } else {
      r.render(this.scene, this.camera);
    }
  }

  /** Coarse max-building-height grid (4 m cells) for cheap sun occlusion rays. */
  _buildHeightGrid() {
    const L = this.layout;
    const cell = 4;
    const nx = Math.ceil(L.extentX / cell);
    const nz = Math.ceil(L.extentZ / cell);
    const h = new Float32Array(nx * nz);
    for (const b of L.buildings) {
      const top = b.y + b.h;
      const x0 = Math.max(0, Math.floor((b.x - b.w / 2 + L.halfX) / cell));
      const x1 = Math.min(nx - 1, Math.floor((b.x + b.w / 2 + L.halfX) / cell));
      const z0 = Math.max(0, Math.floor((b.z - b.d / 2 + L.halfZ) / cell));
      const z1 = Math.min(nz - 1, Math.floor((b.z + b.d / 2 + L.halfZ) / cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) h[z * nx + x] = Math.max(h[z * nx + x], top);
    }
    return { cell, nx, nz, h };
  }

  /** Is the sun hidden behind a building from the camera? (ray march over the height grid) */
  _sunVisibility() {
    const g = this._sunGrid;
    const L = this.layout;
    const s = this.dayNight.sunDir;
    if (!s || s.y <= 0) return 0;
    const c = this.camera.position;
    for (let d = 3; d < 400; d += 3) {
      const x = c.x + s.x * d;
      const y = c.y + s.y * d;
      const z = c.z + s.z * d;
      if (y > 75) return 1;
      const ix = Math.floor((x + L.halfX) / g.cell);
      const iz = Math.floor((z + L.halfZ) / g.cell);
      if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return 1;
      if (g.h[iz * g.nx + ix] > y) return 0;
    }
    return 1;
  }

  /** Main menu mode selector. */
  setMode(mode) {
    this.mode = mode in MODES ? mode : 'free';
    savePrefs({ mode: this.mode });
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
    this.traffic.clear();
    this.traffic.populate(this.car.physics.x, this.car.physics.z);
    this.peds.populate(this.car.physics.x, this.car.physics.z);
    this.car.repair();
    this.score.resetSession();
    this.missions.restart();
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
    on('cycle', () => {
      const auto = this.dayNight.toggleAuto();
      this.settings.time = auto ? 'auto' : this.dayNight.night > 0.5 ? 'night' : 'day';
      savePrefs({ settings: this.settings });
      this.hud.toast(auto ? 'Time cycle on' : 'Time cycle paused');
    });
    on('mute', () => this.hud.toast(this.audio.toggleMute() ? 'Sound off' : 'Sound on'));
    // R: repair any damage (paid from the wallet when possible) and put the
    // car back on the nearest road.
    on('reset', () => {
      const dmg = this.car.damage.level;
      this.car.resetToRoad();
      this.skidMarks.last[0] = this.skidMarks.last[1] = null;
      this.cameraRig.snap();
      if (dmg > 0.02) {
        this.car.repair();
        this.score.spend(dmg * CONFIG.missions.repairCostPerDamage, 'Repair');
        this.hud.toast('Car repaired');
      } else {
        this.hud.toast('Car reset');
      }
    });
    on('pause', () => {
      if (this.state === 'playing') this.setPaused(true);
      else if (this.state === 'paused') this.setPaused(false);
    });
    on('fps', () => this.hud.toggleFps());
    on('horn', () => {
      const p = this.car.physics;
      this.audio.honk(1, this.car.cfg.mass < 800 ? 1.5 : 1);
      this.peds.honk(p.x, p.z, p.heading);
    });
    on('indicatorLeft', () => this.car.toggleIndicator(-1));
    on('indicatorRight', () => this.car.toggleIndicator(1));

    const click = (id, fn) => document.getElementById(id).addEventListener('click', fn);
    click('pause-resume', () => this.setPaused(false));
    click('pause-garage', () => this.openGarage('pause'));
    click('pause-settings', () => this.openSettings('pause'));
    click('pause-restart', () => this.restart());
    click('pause-quit', () => this.quitToMenu());
    const densityBtn = document.getElementById('pause-density');
    const showDensity = () => { densityBtn.textContent = `Traffic: ${this.traffic.density}`; };
    densityBtn.addEventListener('click', () => {
      const levels = Object.keys(CONFIG.traffic.density);
      this.setDensity(levels[(levels.indexOf(this.traffic.density) + 1) % levels.length]);
      showDensity();
    });
    // Auto-pause when the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.setPaused(true);
    });
  }

  setDensity(level) {
    this.applySettings({ density: level });
  }

  /**
   * Apply (and persist) settings. `initial` applies everything, otherwise
   * only what changed, so e.g. moving the volume slider doesn't recompile
   * shaders.
   */
  applySettings(patch, initial = false) {
    const prev = initial ? {} : { ...this.settings };
    const st = Object.assign(this.settings, patch);
    savePrefs({ settings: st });
    const changed = (k) => initial || prev[k] !== st[k];

    if (changed('quality')) {
      const q = CONFIG.quality[st.quality] || CONFIG.quality.medium;
      CONFIG.render.maxPixelRatio = q.pixelRatio;
      CONFIG.render.renderScale = q.renderScale ?? 1;
      CONFIG.render.fogFar = q.drawDistance;
      this._resize();
      if (this.renderer.shadowMap.enabled !== q.shadows) {
        this.renderer.shadowMap.enabled = q.shadows;
        // Shadow on/off changes shader programs: recompile everything once.
        this.scene.traverse((o) => {
          if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
        });
      }
      this.dayNight.setShadowMapSize(q.shadowMapSize, q.shadowArea);
      // Medium re-renders the sun's shadow map every other frame.
      this.shadowRate = q.shadowRate ?? 1;
      this.renderer.shadowMap.autoUpdate = this.shadowRate === 1;
      this.renderer.shadowMap.needsUpdate = true;
      this.trafficRenderer.drawDistance = q.drawDistance * 0.8;
      this.trafficRenderer.detailDistance = q.drawDistance * 0.35;
      this.traffic.countScale = q.trafficScale;
      this.traffic.radiusScale = q.drawDistance / 420;
      this.peds.setCount(q.pedestrians);
      this.peds.cfg.drawDistance = q.pedDrawDistance;
      this.peds.cfg.animDistance = q.pedDrawDistance * 0.5;
      this.headlightShadows = q.headlightShadow;
      this.headlightMode = q.headlights;
      this.car.model.setHeadlightMode(q.headlights);
      this.car.model.setHeadlightShadow(q.headlightShadow);
      this.env.setMode(q.ibl);
      this.dayNight.fullIbl = q.ibl === 'full';
      this.post.configure(q.post);
      this._warmUpShaders();
    }
    if (changed('volume')) this.audio.setVolume(st.volume);
    if (changed('density')) {
      this.traffic.setDensity(st.density);
      document.getElementById('pause-density').textContent = `Traffic: ${this.traffic.density}`;
    }
    if (changed('time')) {
      const dn = this.dayNight;
      dn.autoCycle = st.time === 'auto';
      if (st.time === 'day') dn.time = 0.42;
      if (st.time === 'night') dn.time = 0.92;
      dn.transition = null;
    }
    if (changed('weather')) {
      this.weather.set(st.weather);
      if (initial) this.weather.snap();
    }
  }

  /** Settings screen from the main menu ('menu') or the pause menu ('pause'). */
  openSettings(from) {
    this.settingsFrom = from;
    this.state = 'settings';
    document.getElementById('start').classList.add('hidden');
    document.getElementById('pause').classList.add('hidden');
    this.settingsMenu.open(this.settings);
  }

  _closeSettings() {
    if (this.settingsFrom === 'pause') {
      this.state = 'paused';
      document.getElementById('pause').classList.remove('hidden');
    } else {
      this.state = 'menu';
      document.getElementById('start').classList.remove('hidden');
    }
  }

  /** The player knocked someone over (they get up again a few seconds later). */
  _pedestrianHit(ped, speed) {
    this.audio.impact(Math.min(4 + speed * 0.3, 8));
    this.hud.toast('Watch out for pedestrians!', 2);
    this.score.add(-CONFIG.pedestrians.hitPenalty, 'Pedestrian hit');
    this.missions.onPedestrianHit();
  }

  /** An AI vehicle honks: volume falls off with distance to the player. */
  _aiHonk(v) {
    const p = this.car.physics;
    const d = Math.hypot(v.x - p.x, v.z - p.z);
    const pitch = v.shape.type === 'bus' || v.shape.type === 'truck' ? 0.7
      : v.shape.type === 'motorbike' || v.shape.type === 'tuktuk' ? 1.5 : 1;
    this.audio.honk(Math.min(1, 12 / Math.max(d, 4)) * 0.8, pitch, 0.35);
  }

  /** HUD arrow toward the current mission target, relative to the view direction. */
  _updateWaypoint() {
    const t = this.missions.target;
    if (!t) {
      this.hud.setWaypoint(null);
      return;
    }
    const p = this.car.physics;
    const dx = t.x - p.x;
    const dz = t.z - p.z;
    // View heading: the camera yaw (top-down / chase follow the car).
    const h = this.cameraRig.mode === 'cinematic' ? p.heading : this.cameraRig.yaw;
    const fwd = dx * Math.sin(h) + dz * Math.cos(h);
    const right = -dx * Math.cos(h) + dz * Math.sin(h);
    this.hud.setWaypoint(Math.atan2(right, fwd), Math.hypot(dx, dz));
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
    this.car.fixedUpdate(dt, this.traffic.circlesNear(p.x, p.z), this.weather.grip);
  }

  update(dt, frameDt) {
    if (this.state === 'garage') {
      this.garage.update(frameDt);
      return;
    }
    const car = this.car;
    const p = car.physics;

    // AI traffic sees the player as an obstacle.
    const pl = this._player;
    pl.x = p.x;
    pl.z = p.z;
    pl.heading = p.heading;
    pl.vx = p.vx;
    pl.vz = p.vz;
    pl.circles = carCircles(p.x, p.z, p.heading, pl.circles, car.cfg.circles);
    this.lights.update(dt);
    this.traffic.speedScale = this.weather.trafficSpeed;
    this.traffic.update(dt, pl);
    if (this.state === 'playing' && this.lights.checkPlayer(p.x, p.z, p.vx, p.vz)) {
      this.hud.toast('You ran a red light!', 2);
      this.score.add(-CONFIG.trafficLights.redLightPenalty, 'Red light');
    }
    if (car.lastHit) {
      car.lastHit.bumped = 1.5; // AI car stops briefly after being hit
      car.lastHit = null;
    }

    const impact = car.consumeImpact();
    if (impact > 1.5) {
      this.audio.impact(impact);
      this.cameraRig.addShake(Math.min(impact / 15, 0.8));
      if (this.state === 'playing' && car.applyCrash(impact) > 0.05) {
        this.score.add(-CONFIG.missions.crashPenalty, 'Crash');
        this.missions.onCrash();
      }
    }

    // Lighting first (other systems read the night factor).
    const night = this.dayNight.night;
    // Headlights on at night and in rain / fog.
    const headlights = Math.max(THREE.MathUtils.smoothstep(night, 0.3, 0.6), this.weather.gloom);
    car.syncVisual(dt, headlights);
    if (dt > 0) this.skidMarks.update(p);
    this.cameraRig.update(dt);
    this.dayNight.update(dt, car.position, this.camera);
    this.weather.update(dt, this.dayNight);
    this.env.wet = this.weather.wet;
    this.env.update(this.dayNight.sunDir, night, this.weather.overcast ?? 0);
    this.city.update(night, this.camera.position);
    windUniforms.uTime.value += dt;
    windUniforms.uWind.value = 0.3 + this.weather.rain * 0.5;
    this._frame = (this._frame ?? 0) + 1;
    if (this.shadowRate > 1 && this._frame % this.shadowRate === 0) this.renderer.shadowMap.needsUpdate = true;
    facadeUniforms.uSkyColor.value.copy(this.dayNight.skyUniforms.horizonColor.value);
    this.props.update(night);
    if (this.post.enabled) {
      if (this.post.opts.flare) this._sunVis += (this._sunVisibility() - this._sunVis) * Math.min(1, frameDt * 8);
      const top = Math.max(car.cfg.topSpeedKmh, 120) / 3.6;
      this.post.update(p.speed / top, this.dayNight.exposure, this.dayNight.sunDir, night, this._sunVis);
    }
    this.trafficRenderer.update(night, this.camera.position, dt);
    this.peds.update(dt, pl, this.camera.position, night);
    this.pedRenderer.update(dt, this.camera);
    car.damage.update(dt, car, this.renderer.domElement.clientHeight);
    this.time += dt;
    if (this.state === 'playing') {
      this.missions.update(dt, p.speed, this.time);
      this.score.updateDrift(dt, p);
    }

    if (this.state === 'playing' || this.state === 'paused') {
      this.hud.update(frameDt, {
        redline: car.cfg.redlineRpm,
        speedKmh: p.speedKmh,
        rpm: p.rpm,
        gear: p.gearLabel,
        timeOfDay: this.dayNight.time,
        autoCycle: this.dayNight.autoCycle,
        cameraLabel: this.cameraRig.label,
        trafficCount: this.traffic.vehicles.length,
        muted: this.audio.muted,
      });
      this.minimap.update(p, this.traffic.cars, this.missions.markers);
      this.hud.setScore(MODES[this.mode], this.score.points, this.score.money);
      this.hud.setDamage(car.damage.level);
      this.hud.setIndicators(car.blinkOn && (car.indicator === -1 || car.indicator === 2), car.blinkOn && car.indicator >= 1);
      this._updateWaypoint();
      this.audio.update(p.rpm, p.throttle, p.skid, p.speed);
      let near = 0;
      for (const v of this.traffic.vehicles) if (Math.abs(v.x - p.x) < 80 && Math.abs(v.z - p.z) < 80) near++;
      this.cityAudio.update(frameDt, near, this.weather.rain, p.speed);
    }
  }
}
