import { CONFIG } from '../config.js';

/**
 * Fully synthesised car audio (Web Audio API, no samples):
 *  - engine: three detuned oscillators at the firing frequency, soft-clipped
 *    and low-passed; cutoff and volume follow throttle and RPM
 *  - tyre screech: band-passed noise, gain follows tyre slip
 *  - wind: low-passed noise growing with speed
 *  - impact: short filtered noise burst on collisions
 * The AudioContext is only created from a user gesture (browser autoplay rules).
 */
export class EngineSound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.ready = false;
  }

  /** Must be called from a user-gesture handler (click / keydown). */
  start() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const cfg = CONFIG.audio;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : cfg.masterVolume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // --- Engine --------------------------------------------------------------
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 600;
    this.engineFilter.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(6);
    shaper.oversample = '2x';
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    mix.connect(shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.master);

    const mkOsc = (type, gain, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(mix);
      o.start();
      return o;
    };
    this.oscMain = mkOsc('sawtooth', 0.6);
    this.oscSub = mkOsc('square', 0.35);
    this.oscHigh = mkOsc('sawtooth', 0.18, 9);

    // Uneven "firing" roughness: tremolo at half the firing rate.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.18;
    this.lfo.connect(lfoDepth).connect(mix.gain);
    this.lfo.start();

    // --- Noise-based layers ----------------------------------------------------
    const noise = makeNoiseBuffer(ctx, 2);

    const screechSrc = ctx.createBufferSource();
    screechSrc.buffer = noise;
    screechSrc.loop = true;
    this.screechFilter = ctx.createBiquadFilter();
    this.screechFilter.type = 'bandpass';
    this.screechFilter.frequency.value = 1900;
    this.screechFilter.Q.value = 9;
    const screechFilter2 = ctx.createBiquadFilter();
    screechFilter2.type = 'peaking';
    screechFilter2.frequency.value = 3200;
    screechFilter2.gain.value = 10;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    screechSrc.connect(this.screechFilter).connect(screechFilter2).connect(this.screechGain).connect(this.master);
    screechSrc.start();

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noise;
    windSrc.loop = true;
    windSrc.playbackRate.value = 0.7;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 450;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();

    this.noise = noise;
    this.ready = true;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ready) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : CONFIG.audio.masterVolume, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  setPaused(paused) {
    if (!this.ready) return;
    if (paused) this.ctx.suspend();
    else this.ctx.resume();
  }

  /** rpm, throttle 0..1, skid 0..1, speed m/s */
  update(rpm, throttle, skid, speed) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const cfg = CONFIG.audio;
    const k = 0.04; // smoothing time constant (s)

    // Firing frequency of a 4-stroke engine: rpm/60 * cylinders/2.
    const f = (rpm / 60) * (cfg.cylinders / 2);
    this.oscMain.frequency.setTargetAtTime(f, t, k);
    this.oscSub.frequency.setTargetAtTime(f * 0.5, t, k);
    this.oscHigh.frequency.setTargetAtTime(f * 2, t, k);
    this.lfo.frequency.setTargetAtTime(f * 0.5, t, k);

    const rpmN = Math.min(rpm / CONFIG.car.redlineRpm, 1);
    this.engineFilter.frequency.setTargetAtTime(250 + rpmN * 1400 + throttle * 1300, t, k);
    this.engineGain.gain.setTargetAtTime(cfg.engineVolume * (0.45 + throttle * 0.4 + rpmN * 0.35), t, k);

    // Screech: gain follows slip, pitch wobbles a little.
    this.screechGain.gain.setTargetAtTime(cfg.screechVolume * Math.min(skid, 1) ** 1.5, t, 0.05);
    this.screechFilter.frequency.setTargetAtTime(1600 + skid * 700 + Math.sin(t * 13) * 120, t, 0.05);

    const wind = Math.min(speed / 55, 1);
    this.windGain.gain.setTargetAtTime(wind * wind * 0.35, t, 0.2);
  }

  /** Collision thump; strength in m/s of impact speed. */
  impact(strength) {
    if (!this.ready || strength < 1.5) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 300 + Math.min(strength, 20) * 60;
    const g = ctx.createGain();
    const vol = Math.min(strength / 12, 1) * 0.9;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }
}

function makeNoiseBuffer(ctx, seconds) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function makeDistortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}
