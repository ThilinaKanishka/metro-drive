import { CONFIG } from '../config.js';

const MAX_KMH = 240;
const START = Math.PI * 0.75;   // dial starts bottom-left
const SWEEP = Math.PI * 1.5;    // 270 degrees of travel

/**
 * HUD: analog speedometer with RPM ring + digital readout + gear, FPS
 * counter, status line and toast messages. The static dial face is drawn
 * once to an offscreen canvas; each frame only draws needle and text.
 */
export class Hud {
  constructor() {
    this.root = document.getElementById('hud');
    this.fpsEl = document.getElementById('fps');
    this.statusEl = document.getElementById('status');
    this.toastEl = document.getElementById('toast');
    this.canvas = document.getElementById('speedo-canvas');
    this.ctx = this.canvas.getContext('2d');

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = 220;
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.ctx.scale(dpr, dpr);
    this.dial = this._drawDial(dpr);

    this.frames = 0;
    this.fpsTime = 0;
    this.toastTimer = 0;
    this.statusTimer = 0;
  }

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  toggleFps() {
    this.fpsEl.classList.toggle('hidden');
  }

  toast(text, seconds = 1.6) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this.toastTimer = seconds;
  }

  /** frameDt: real frame time (for FPS), state: values to display. */
  update(frameDt, state) {
    // FPS: averaged over half a second.
    this.frames++;
    this.fpsTime += frameDt;
    if (this.fpsTime >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.frames / this.fpsTime)} FPS`;
      this.frames = 0;
      this.fpsTime = 0;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= frameDt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }

    // Status text changes rarely; avoid touching the DOM every frame.
    this.statusTimer -= frameDt;
    if (this.statusTimer <= 0) {
      this.statusTimer = 0.25;
      const t = state.timeOfDay * 24;
      const hh = String(Math.floor(t)).padStart(2, '0');
      const mm = String(Math.floor((t % 1) * 60)).padStart(2, '0');
      this.statusEl.textContent =
        `${hh}:${mm}${state.autoCycle ? '' : ' (time frozen)'}   ${state.cameraLabel}\n` +
        `Traffic: ${state.trafficCount}   Sound: ${state.muted ? 'off' : 'on'}`;
    }

    this._drawSpeedo(state.speedKmh, state.rpm, state.gear, state.redline);
  }

  _drawDial(dpr) {
    const s = this.size;
    const c = document.createElement('canvas');
    c.width = s * dpr;
    c.height = s * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    const cx = s / 2;
    const cy = s / 2;
    const r = s / 2 - 6;

    ctx.fillStyle = 'rgba(10, 13, 19, 0.72)';
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Ticks and labels.
    for (let v = 0; v <= MAX_KMH; v += 10) {
      const a = START + (v / MAX_KMH) * SWEEP;
      const major = v % 20 === 0;
      const inner = r - (major ? 16 : 9);
      ctx.strokeStyle = v >= 200 ? '#ff5a3c' : 'rgba(238,242,247,0.85)';
      ctx.lineWidth = major ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(238,242,247,0.8)';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(v), cx + Math.cos(a) * (r - 30), cy + Math.sin(a) * (r - 30));
      }
    }
    ctx.fillStyle = 'rgba(154,166,181,0.9)';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText('km/h', cx, cy + 58);
    return c;
  }

  _drawSpeedo(kmh, rpm, gear, redline = CONFIG.car.redlineRpm) {
    const ctx = this.ctx;
    const s = this.size;
    const cx = s / 2;
    const cy = s / 2;
    const r = s / 2 - 6;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this.dial, 0, 0, s, s);

    // RPM ring (inner arc) turns red near the redline.
    const rpmRatio = Math.min(rpm / redline, 1);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 46, START, START + SWEEP);
    ctx.stroke();
    ctx.strokeStyle = rpmRatio > 0.88 ? '#ff5a3c' : '#4fc3f7';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 46, START, START + SWEEP * rpmRatio);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // Needle.
    const a = START + (Math.min(kmh, MAX_KMH) / MAX_KMH) * SWEEP;
    ctx.strokeStyle = '#ff5a3c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * 10, cy - Math.sin(a) * 10);
    ctx.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
    ctx.stroke();
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();

    // Digital readout + gear.
    ctx.fillStyle = '#eef2f7';
    ctx.font = '700 30px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(kmh)), cx, cy + 36);
    ctx.font = '800 16px ui-monospace, monospace';
    ctx.fillStyle = gear === 'R' ? '#ff5a3c' : '#4fc3f7';
    ctx.fillText(gear, cx, cy + 78);
  }
}
