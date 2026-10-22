/**
 * Ambient city sound, layered on the engine audio's context and master bus:
 *  - distant traffic: low-passed noise whose level follows how many vehicles
 *    are nearby
 *  - the odd distant horn at random intervals
 *  - rain: band-passed hiss plus a soft low patter, following the weather
 * Built lazily once the engine audio exists (after the first user gesture).
 */
export class CityAudio {
  constructor(engine) {
    this.engine = engine;
    this.ready = false;
    this.hornTimer = 6;
  }

  _build() {
    const e = this.engine;
    const ctx = e.ctx;
    const loop = (rate) => {
      const src = ctx.createBufferSource();
      src.buffer = e.noise;
      src.loop = true;
      src.playbackRate.value = rate;
      src.start(0, Math.random() * 1.5);
      return src;
    };

    // Traffic rumble.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    this.trafficGain = ctx.createGain();
    this.trafficGain.gain.value = 0;
    loop(0.5).connect(lp).connect(this.trafficGain).connect(e.master);

    // Rain hiss + patter.
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3200;
    hp.Q.value = 0.4;
    const patter = ctx.createBiquadFilter();
    patter.type = 'lowpass';
    patter.frequency.value = 700;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    const src = loop(1);
    src.connect(hp).connect(this.rainGain);
    src.connect(patter).connect(this.rainGain);
    this.rainGain.connect(e.master);
    this.ready = true;
  }

  /** nearbyTraffic: vehicles within ~80 m; rain 0..1; speed m/s (wind masks ambience). */
  update(dt, nearbyTraffic, rain, speed) {
    const e = this.engine;
    if (!e.ready) return;
    if (!this.ready) this._build();
    const t = e.ctx.currentTime;
    const busy = Math.min(nearbyTraffic / 14, 1);
    const masked = 1 - Math.min(speed / 40, 0.6);
    this.trafficGain.gain.setTargetAtTime((0.05 + busy * 0.16) * masked, t, 0.8);
    this.rainGain.gain.setTargetAtTime(rain * 0.22, t, 0.6);

    // A horn somewhere in the city now and then.
    this.hornTimer -= dt;
    if (this.hornTimer <= 0) {
      this.hornTimer = 7 + Math.random() * 16;
      if (busy > 0.15) e.honk(0.08 + Math.random() * 0.1, 0.8 + Math.random() * 0.5, 0.2 + Math.random() * 0.35);
    }
  }
}
