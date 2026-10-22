import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PED_STATE } from './pedestrians.js';

const { WALK, TO_KERB, CROSS, BOARD, FLEE, FALLEN, GETUP } = PED_STATE;

/**
 * Near LOD for pedestrians: the closest people (up to `maxNear`, within
 * `nearDistance`) are drawn as rigged glTF characters animated with
 * AnimationMixer (walk / sprint / idle / fall); everyone else stays on the
 * instanced procedural renderer. Character instances are pooled per model
 * and handed from person to person as the camera moves.
 */
export class CharacterLod {
  constructor(scene, peds, characters) {
    this.scene = scene;
    this.peds = peds;
    this.characters = characters; // [{ id, template, clips }]
    this.maxNear = 16;
    this.nearDistance = 40;
    this.pool = characters.map(() => []);
    this.active = new Map(); // ped -> instance
    this._cand = [];
    this.time = 0;
  }

  get enabled() {
    return this.characters.length > 0 && this.maxNear > 0;
  }

  _acquire(kind) {
    const free = this.pool[kind].pop();
    if (free) {
      free.root.visible = true;
      return free;
    }
    const c = this.characters[kind];
    const root = cloneSkinned(c.template);
    const mixer = new THREE.AnimationMixer(root);
    const actions = {};
    for (const [name, clip] of Object.entries(c.clips)) actions[name] = mixer.clipAction(clip);
    if (actions.die) {
      actions.die.setLoop(THREE.LoopOnce, 1);
      actions.die.clampWhenFinished = true;
    }
    let armR = null;
    root.traverse((o) => { if (o.isBone && o.name === 'arm-right') armR = o; });
    const inst = { kind, root, mixer, actions, current: null, armR };
    this.scene.add(root);
    return inst;
  }

  _release(inst) {
    inst.root.visible = false;
    inst.current?.stop();
    inst.current = null;
    this.pool[inst.kind].push(inst);
  }

  _play(inst, name, fade = 0.25) {
    const next = inst.actions[name] ?? inst.actions.idle;
    if (!next || inst.current === next) return next;
    next.reset().play();
    if (inst.current) next.crossFadeFrom(inst.current, fade, false);
    inst.current = next;
    return next;
  }

  /** Assign characters to the nearest people and animate them. */
  update(dt) {
    this.time += dt;
    const near2 = this.nearDistance * this.nearDistance;
    // Candidates: visible, close, not hidden in a taxi.
    const cand = this._cand;
    cand.length = 0;
    if (this.enabled) {
      for (const p of this.peds.list) {
        if (p.visible && !p.hidden && p.dist * p.dist < near2) cand.push(p);
      }
      cand.sort((a, b) => a.dist - b.dist);
      if (cand.length > this.maxNear) cand.length = this.maxNear;
    }
    const keep = new Set(cand);
    for (const [p, inst] of this.active) {
      if (!keep.has(p)) {
        this._release(inst);
        this.active.delete(p);
        p.modelled = false;
      }
    }
    for (const p of cand) {
      let inst = this.active.get(p);
      if (!inst) {
        inst = this._acquire(p.id % this.characters.length);
        this.active.set(p, inst);
        p.modelled = true;
      }
      this._animate(p, inst, dt);
    }
  }

  _animate(p, inst, dt) {
    const s = p.state;
    let action;
    if (s === FALLEN) action = this._play(inst, 'die', 0.15);
    else if (s === GETUP) action = this._play(inst, 'idle', 0.8);
    else if (s === FLEE || p.speed > 2.5) {
      action = this._play(inst, 'sprint', 0.15);
      action.timeScale = p.speed / 4.5;
    } else if ((s === WALK || s === TO_KERB || s === CROSS || s === BOARD) && p.speed > 0.05) {
      action = this._play(inst, 'walk');
      // The walk cycle covers ~1.3 m; match the feet to the ground speed.
      action.timeScale = p.speed / (1.3 * p.scale);
    } else {
      action = this._play(inst, 'idle');
      action.timeScale = 1;
    }
    inst.mixer.update(dt);
    // Taxi passengers hail: raise the right arm over the idle pose.
    if (p.waving && inst.armR) inst.armR.rotation.x = Math.PI * 0.9 + Math.sin(this.time * 7) * 0.25;
    const r = inst.root;
    r.position.set(p.x, p.hop + r.userData.baseY, p.z);
    r.rotation.y = p.yaw;
    r.scale.setScalar(p.scale * r.userData.baseScale);
  }

  /** Remove every character (e.g. quality set to Low). */
  clear() {
    for (const [p, inst] of this.active) {
      this._release(inst);
      p.modelled = false;
    }
    this.active.clear();
  }
}
