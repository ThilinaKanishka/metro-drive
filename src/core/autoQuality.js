/**
 * "Auto" graphics quality. Measures the real frame rate and adapts:
 *  1. dynamic resolution: the render scale moves between MIN_SCALE and the
 *     preset's own scale to keep ~55-60 FPS (cheap: no shader changes)
 *  2. if the scale is at its floor and FPS stays below 45, drop one preset
 *     (Ultra -> High -> Medium -> Low); after a long stretch at a solid 60
 *     with full scale it may step back up, never above the starting preset
 * Frames are only sampled while driving (menus / pause don't count).
 */
const LEVELS = ['low', 'medium', 'high', 'ultra'];
const MIN_SCALE = 0.55;

export class AutoQuality {
  constructor({ start = 'medium', apply, setScale, notify }) {
    this.start = start;
    this.level = start;
    this.apply = apply;         // (level) => void   switch preset
    this.setScale = setScale;   // (scale) => void   change render scale only
    this.notify = notify;       // (text) => void
    this.enabled = false;
    this.reset(1);
  }

  reset(presetScale) {
    this.presetScale = presetScale;
    this.scale = presetScale;
    this.frames = 0;
    this.time = 0;
    this.lowTime = 0;
    this.goodTime = 0;
    this.cooldown = 3;          // ignore the first seconds (shader compiles, loading)
  }

  /** Call every frame while driving with the real frame time. */
  update(frameDt) {
    if (!this.enabled || frameDt <= 0) return;
    if (this.cooldown > 0) {
      this.cooldown -= frameDt;
      return;
    }
    this.frames++;
    this.time += frameDt;
    if (this.time < 1) return;
    const fps = this.frames / this.time;
    this.fps = fps;
    this.frames = 0;
    this.time = 0;

    // 1. Resolution.
    if (fps < 52 && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale - (fps < 40 ? 0.1 : 0.05));
      this.setScale(this.scale);
    } else if (fps > 58.5 && this.scale < this.presetScale) {
      this.scale = Math.min(this.presetScale, this.scale + 0.05);
      this.setScale(this.scale);
    }

    // 2. Presets.
    this.lowTime = fps < 45 && this.scale <= MIN_SCALE + 1e-3 ? this.lowTime + 1 : 0;
    this.goodTime = fps > 58.5 && this.scale >= this.presetScale - 1e-3 ? this.goodTime + 1 : 0;
    const i = LEVELS.indexOf(this.level);
    if (this.lowTime >= 3 && i > 0) {
      this._switch(LEVELS[i - 1]);
    } else if (this.goodTime >= 20 && i < LEVELS.indexOf(this.start)) {
      this._switch(LEVELS[i + 1]);
    }
  }

  _switch(level) {
    this.level = level;
    this.apply(level);
    this.notify?.(`Graphics: ${level} (auto)`);
    this.lowTime = 0;
    this.goodTime = 0;
    this.cooldown = 3;
  }
}
