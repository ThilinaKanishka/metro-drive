/**
 * Keyboard + virtual (touch) input. Continuous controls are exposed as
 * booleans; one-shot actions (camera, pause...) are dispatched as callbacks.
 */
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
};

const ACTIONS = {
  KeyC: 'camera',
  KeyN: 'daynight',
  KeyM: 'mute',
  KeyR: 'reset',
  KeyP: 'pause',
  Escape: 'pause',
  KeyF: 'fps',
  KeyT: 'cycle',
};

export class Input {
  constructor() {
    this.state = { up: false, down: false, left: false, right: false, handbrake: false };
    this.virtual = { up: false, down: false, left: false, right: false, handbrake: false };
    this.listeners = {};
    this.enabled = false;

    window.addEventListener('keydown', (e) => {
      if (KEYMAP[e.code]) {
        this.state[KEYMAP[e.code]] = true;
        e.preventDefault();
      }
      if (ACTIONS[e.code] && !e.repeat && this.enabled) this.emit(ACTIONS[e.code]);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (KEYMAP[e.code]) this.state[KEYMAP[e.code]] = false;
    });
    // Release everything when the window loses focus to avoid stuck keys.
    window.addEventListener('blur', () => {
      for (const k in this.state) this.state[k] = false;
    });
  }

  on(action, fn) {
    (this.listeners[action] ||= []).push(fn);
  }

  emit(action) {
    for (const fn of this.listeners[action] || []) fn();
  }

  /** Merged keyboard + touch state, as analog-ish values. */
  get controls() {
    const s = this.state;
    const v = this.virtual;
    return {
      throttle: s.up || v.up ? 1 : 0,
      brake: s.down || v.down ? 1 : 0,
      steer: (s.left || v.left ? 1 : 0) - (s.right || v.right ? 1 : 0), // +1 = left
      handbrake: s.handbrake || v.handbrake,
    };
  }
}
