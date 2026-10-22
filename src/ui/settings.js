/**
 * Settings screen: segmented choices + a volume slider, built from a small
 * schema. Changes apply immediately through `onChange(patch)` (the game
 * persists them). Opened from the main menu or the pause menu; Esc / Back
 * returns there.
 */
const ROWS = [
  { key: 'quality', label: 'Graphics', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']] },
  { key: 'volume', label: 'Volume', range: true },
  { key: 'density', label: 'Traffic', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'time', label: 'Time of day', options: [['auto', 'Cycle'], ['day', 'Day'], ['night', 'Night']] },
  { key: 'weather', label: 'Weather', options: [['random', 'Random'], ['clear', 'Clear'], ['rain', 'Rain'], ['fog', 'Fog']] },
];

export class SettingsMenu {
  constructor({ onChange, onClose }) {
    this.onChange = onChange;
    this.onClose = onClose;
    this.root = document.getElementById('settings');
    this.isOpen = false;
    const body = document.getElementById('settings-rows');
    this.controls = {};

    for (const row of ROWS) {
      const el = document.createElement('div');
      el.className = 'setting-row';
      const label = document.createElement('span');
      label.textContent = row.label;
      el.appendChild(label);
      if (row.range) {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '100';
        input.addEventListener('input', () => this.onChange({ [row.key]: Number(input.value) / 100 }));
        el.appendChild(input);
        this.controls[row.key] = { set: (v) => { input.value = String(Math.round(v * 100)); } };
      } else {
        const group = document.createElement('div');
        group.className = 'mode-select';
        for (const [value, text] of row.options) {
          const b = document.createElement('button');
          b.dataset.value = value;
          b.textContent = text;
          b.addEventListener('click', () => {
            this.onChange({ [row.key]: value });
            this._mark(group, value);
          });
          group.appendChild(b);
        }
        el.appendChild(group);
        this.controls[row.key] = { set: (v) => this._mark(group, v) };
      }
      body.appendChild(el);
    }
    document.getElementById('settings-back').addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (this.isOpen && e.code === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
  }

  _mark(group, value) {
    for (const b of group.children) b.classList.toggle('active', b.dataset.value === value);
  }

  open(settings) {
    for (const k in this.controls) this.controls[k].set(settings[k]);
    this.isOpen = true;
    this.root.classList.remove('hidden');
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.add('hidden');
    this.onClose?.();
  }
}
