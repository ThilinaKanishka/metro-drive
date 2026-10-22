import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CONFIG } from '../config.js';
import { createPlayerCar } from '../vehicle/carModel.js';
import { computeCarStats, CAR_IDS } from '../vehicle/carStats.js';
import { damp } from '../core/utils.js';

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * Garage / car select. A small studio scene (turntable, floor, lights,
 * reflections) rendered by the game's own WebGLRenderer while open, plus a
 * DOM overlay with the car list, stat bars and paint swatches.
 *
 * Keys: ↑/↓ car, ←/→ paint, Enter drive, Esc back. Drag to spin the car.
 */
export class Garage {
  constructor(renderer, { onDrive, onBack }) {
    this.renderer = renderer;
    this.onDrive = onDrive;
    this.onBack = onBack;
    this.isOpen = false;
    this.carId = CONFIG.player.car;
    this.color = CONFIG.player.color;
    this.model = null;
    this.spin = 0;
    this.spinVel = 0.35;
    this.dragging = false;

    this._buildScene();
    this._buildDom();
    this._bindInput();
  }

  // --------------------------------------------------------------- 3D scene
  _buildScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14171d);
    scene.fog = new THREE.Fog(0x14171d, 14, 34);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.7;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 100);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(40, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.55, metalness: 0.2 }),
    );
    floor.receiveShadow = true;
    scene.add(floor);

    this.turntable = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 4.3, 0.12, 64),
      new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.35, metalness: 0.6 }),
    );
    disc.position.y = 0.06;
    disc.receiveShadow = true;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4.25, 0.03, 6, 96).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff5a3c }),
    );
    ring.position.y = 0.12;
    scene.add(disc, ring);
    this.turntable.position.y = 0.12;
    scene.add(this.turntable);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    key.shadow.bias = -0.0005;
    const rim = new THREE.DirectionalLight(0x8fb4ff, 1.2);
    rim.position.set(-6, 4, -7);
    scene.add(key, rim, new THREE.HemisphereLight(0xcfd8e8, 0x202228, 0.6));
    this.scene = scene;
  }

  // ------------------------------------------------------------------- DOM
  _buildDom() {
    this.root = document.getElementById('garage');
    this.list = document.getElementById('garage-list');
    this.nameEl = document.getElementById('garage-name');
    this.specsEl = document.getElementById('garage-specs');
    this.colorsEl = document.getElementById('garage-colors');
    this.bars = {};
    for (const el of this.root.querySelectorAll('.stat')) {
      this.bars[el.dataset.stat] = el.querySelector('i');
    }

    for (const id of CAR_IDS) {
      const btn = document.createElement('button');
      btn.className = 'garage-car';
      btn.dataset.id = id;
      btn.textContent = CONFIG.cars[id].name;
      btn.addEventListener('click', () => this.select(id));
      this.list.appendChild(btn);
    }
    for (const c of CONFIG.paintColors) {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.style.background = hex(c);
      sw.dataset.color = String(c);
      sw.setAttribute('aria-label', `Paint ${hex(c)}`);
      sw.addEventListener('click', () => this.setColor(c));
      this.colorsEl.appendChild(sw);
    }
    document.getElementById('garage-drive').addEventListener('click', () => this._drive());
    document.getElementById('garage-back').addEventListener('click', () => this._back());
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.repeat) return;
      const step = (arr, cur, d) => arr[(arr.indexOf(cur) + d + arr.length) % arr.length];
      switch (e.code) {
        case 'ArrowUp': case 'KeyW': this.select(step(CAR_IDS, this.carId, -1)); break;
        case 'ArrowDown': case 'KeyS': this.select(step(CAR_IDS, this.carId, 1)); break;
        case 'ArrowLeft': case 'KeyA': this.setColor(step(CONFIG.paintColors, this.color, -1)); break;
        case 'ArrowRight': case 'KeyD': this.setColor(step(CONFIG.paintColors, this.color, 1)); break;
        case 'Enter': this._drive(); break;
        case 'Escape': this._back(); break;
        default: return;
      }
      e.preventDefault();
    });
    // Drag anywhere on the canvas to spin the turntable.
    const canvas = this.renderer.domElement;
    let lastX = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      this.dragging = true;
      lastX = e.clientX;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      this.spin += dx * 0.01;
      this.spinVel = dx * 0.6;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });
  }

  // ---------------------------------------------------------------- control
  open(carId, color) {
    this.isOpen = true;
    this.root.classList.remove('hidden');
    document.body.classList.add('in-garage');
    if (!CONFIG.paintColors.includes(color)) color = CONFIG.paintColors[0];
    this.color = color;
    this.carId = null; // force a rebuild
    this.select(carId in CONFIG.cars ? carId : CONFIG.player.car);
    this.setColor(color);
    this.resize();
  }

  close() {
    this.isOpen = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('in-garage');
  }

  _drive() {
    this.close();
    this.onDrive?.(this.carId, this.color);
  }

  _back() {
    this.close();
    this.onBack?.();
  }

  select(id) {
    if (id === this.carId) return;
    this.carId = id;
    this.model?.dispose();
    const def = CONFIG.cars[id];
    this.model = createPlayerCar(def.shape, this.color);
    this.model.setLights(0.25, false);
    this.turntable.add(this.model.root);
    this.spinVel = 2.5; // little flourish on change

    for (const b of this.list.children) b.classList.toggle('active', b.dataset.id === id);
    this.nameEl.textContent = def.name;

    const s = computeCarStats(id);
    for (const k in this.bars) this.bars[k].style.width = `${Math.round(s.bars[k] * 100)}%`;
    this.specsEl.innerHTML = [
      ['0-' + s.accelTarget + ' km/h', `${s.accelTime.toFixed(1)} s`],
      ['Top speed', `${Math.round(s.topSpeed)} km/h`],
      ['Braking 80-0', `${s.brakeDist.toFixed(0)} m`],
      ['Mass', `${s.mass} kg`],
      ['Engine', def.sound.cylinders === 1 ? '1-cyl' : `${def.sound.cylinders}-cyl`],
      ['Drift', '●'.repeat(Math.round(def.drift * 5) || 1)],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');

    // Frame the car: longer cars sit farther from the camera.
    const shape = this.model.shape;
    this.camDist = 8 + shape.length * 0.9;
    this.camHeight = 1.8 + shape.height * 0.8;
    this.lookY = shape.height * 0.45;
  }

  setColor(c) {
    this.color = c;
    this.model?.setColor(c);
    for (const sw of this.colorsEl.children) sw.classList.toggle('active', Number(sw.dataset.color) === c);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    // Narrow screens: pull the camera back so the car still fits.
    this.camera.zoom = Math.min(1, this.camera.aspect / 1.4);
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    if (!this.isOpen || !this.model) return;
    if (!this.dragging) {
      this.spinVel += (0.35 - this.spinVel) * damp(1.5, dt);
      this.spin += this.spinVel * dt;
    }
    this.turntable.rotation.y = this.spin;
    const d = this.camDist;
    this.camera.position.set(d * 0.78, this.camHeight, d * 0.62);
    this.camera.lookAt(0, this.lookY, 0);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
