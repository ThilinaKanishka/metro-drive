import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, SMAAEffect, SMAAPreset, FXAAEffect, Effect, EffectAttribute, BlendFunction,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

/**
 * Post-processing chain (pmndrs "postprocessing" + N8AO), HDR half-float:
 *
 *   RenderPass → N8AO (High+) → speed blur (High+, only when fast)
 *   → [bloom + lens flare (Ultra) + film] → SMAA
 *
 * "Film" is one merged effect: exposure, ACES filmic tone mapping, colour
 * grading (contrast, saturation, lift / gain, white balance), vignette and
 * film grain. Because tone mapping happens here, the renderer runs with
 * NoToneMapping while the composer is active.
 *
 * Low quality bypasses the composer entirely (renderer tone mapping only).
 */
export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;
    const size = renderer.getSize(new THREE.Vector2());

    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
    this.renderPass = new RenderPass(scene, camera);
    this.ao = new N8AOPostPass(scene, camera, size.x, size.y);
    Object.assign(this.ao.configuration, {
      aoRadius: 2.2, distanceFalloff: 1.2, intensity: 2.2, gammaCorrection: false, halfRes: true, color: new THREE.Color(0, 0, 0),
    });
    this.ao.setQualityMode('Performance');

    this.speedBlur = new SpeedBlurEffect();
    this.speedPass = new EffectPass(camera, this.speedBlur);

    this.bloom = new BloomEffect({
      mipmapBlur: true, intensity: 0.85, luminanceThreshold: 1.0, luminanceSmoothing: 0.35, radius: 0.72,
    });
    this.flare = new LensFlareEffect();
    this.film = new FilmEffect();
    this.mainPass = new EffectPass(camera, this.bloom, this.flare, this.film);
    // Anti-aliasing: SMAA (3 passes, best) or FXAA (1 pass, cheap: Medium).
    this.smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
    this.smaaPass = new EffectPass(camera, this.smaa);
    this.fxaa = new FXAAEffect();
    this.fxaaPass = new EffectPass(camera, this.fxaa);

    for (const p of [this.renderPass, this.ao, this.speedPass, this.mainPass, this.smaaPass, this.fxaaPass]) {
      this.composer.addPass(p);
    }
    this._v = new THREE.Vector3();
  }

  /**
   * opts: { enabled, ao: 'off' | 'half' | 'full', bloom, speedBlur, flare, grain }
   */
  configure(opts) {
    this.opts = opts;
    this.enabled = !!opts.enabled;
    this.renderer.toneMapping = this.enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.ao.enabled = this.enabled && opts.ao !== 'off';
    this.ao.configuration.halfRes = opts.ao !== 'full';
    this.ao.setQualityMode(opts.ao === 'full' ? 'Medium' : 'Performance');
    this.bloom.blendMode.opacity.value = opts.bloom ? 1 : 0;
    // Fewer MIP levels = cheaper (and slightly tighter) bloom.
    this.bloom.mipmapBlurPass.levels = opts.ao === 'full' ? 7 : opts.ao === 'half' ? 6 : 4;
    this.smaaPass.enabled = opts.aa === 'smaa';
    this.fxaaPass.enabled = opts.aa === 'fxaa';
    // Only the last enabled pass may write to the screen.
    const passes = this.composer.passes;
    let last = null;
    for (const p of passes) if (p.enabled) last = p;
    for (const p of passes) p.renderToScreen = p === last;
    this.speedEnabled = !!opts.speedBlur;
    this.flare.blendMode.opacity.value = opts.flare ? 1 : 0;
    this.film.uniforms.get('grain').value = opts.grain ? 0.035 : 0;
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
  }

  /**
   * Per-frame parameters. speed01: car speed / top speed; exposure from the
   * day/night system; sunDir: world direction to the sun; night 0..1;
   * sunVisible 0..1 (occlusion by buildings, computed by the caller).
   */
  update(speed01, exposure, sunDir, night, sunVisible = 1) {
    const f = this.film.uniforms;
    f.get('exposure').value = exposure;
    // Warmer, slightly lifted shadows at night (sodium street lights); crisper by day.
    f.get('warmth').value = 0.04 + night * 0.06;
    f.get('saturation').value = 1.08 - night * 0.12;
    // Daylight: only the sun / hot highlights bloom; night: lamps, neon, brake lights.
    this.bloom.intensity = 0.55 + night * 0.65;
    this.bloom.luminanceMaterial.threshold = 1.7 - night * 0.85;

    const blur = this.speedEnabled ? THREE.MathUtils.smoothstep(speed01, 0.45, 1) : 0;
    this.speedBlur.uniforms.get('strength').value = blur * 0.06;
    this.speedPass.enabled = blur > 0.01;

    // Sun position on screen for the lens flare.
    if (this.flare.blendMode.opacity.value > 0) {
      const p = this._v.copy(this.camera.position).addScaledVector(sunDir, 500).project(this.camera);
      const inFront = p.z < 1 && sunDir.y > -0.02;
      const onScreen = Math.max(0, 1 - Math.max(Math.abs(p.x), Math.abs(p.y)) * 0.8);
      this.flare.uniforms.get('sun').value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
      this.flare.uniforms.get('flareAspect').value = this.camera.aspect;
      const target = inFront ? onScreen * sunVisible * (1 - night) : 0;
      const cur = this.flare.uniforms.get('strength').value;
      this.flare.uniforms.get('strength').value = cur + (target - cur) * 0.15;
    }
  }

  render(dt) {
    this.composer.render(dt);
  }
}

/** Exposure + ACES + grading + vignette + grain in one effect. */
class FilmEffect extends Effect {
  constructor() {
    super('FilmEffect', /* glsl */ `
      uniform float exposure;
      uniform float contrast;
      uniform float saturation;
      uniform float warmth;
      uniform vec3 lift;
      uniform vec3 gain;
      uniform float vignette;
      uniform float grain;

      vec3 RRTAndODTFit(vec3 v) {
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
      }
      vec3 acesFilmic(vec3 color) {
        const mat3 ACESInputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
        const mat3 ACESOutputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
        color *= exposure / 0.6;
        color = ACESInputMat * color;
        color = RRTAndODTFit(color);
        color = ACESOutputMat * color;
        return clamp(color, 0.0, 1.0);
      }
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = acesFilmic(inputColor.rgb);
        // White balance: warm / cool shift.
        c *= vec3(1.0 + warmth, 1.0, 1.0 - warmth);
        // Lift / gain (shadows / highlights tint), contrast around mid grey, saturation.
        c = c * gain + lift * (1.0 - c);
        c = (c - 0.5) * contrast + 0.5;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, saturation);
        // Vignette.
        vec2 d = uv - 0.5;
        c *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
        // Film grain (luminance-weighted so blacks stay clean-ish).
        float n = hash12(uv * resolution + fract(time * 13.7) * 100.0) - 0.5;
        c += n * grain * (0.35 + l);
        outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['exposure', new THREE.Uniform(0.7)],
        ['contrast', new THREE.Uniform(1.06)],
        ['saturation', new THREE.Uniform(1.08)],
        ['warmth', new THREE.Uniform(0.04)],
        ['lift', new THREE.Uniform(new THREE.Vector3(0.012, 0.014, 0.022))],
        ['gain', new THREE.Uniform(new THREE.Vector3(1.0, 0.99, 0.97))],
        ['vignette', new THREE.Uniform(0.32)],
        ['grain', new THREE.Uniform(0.035)],
      ]),
    });
  }
}

/** Radial blur toward the screen centre, stronger at the edges (speed sensation). */
class SpeedBlurEffect extends Effect {
  constructor() {
    super('SpeedBlurEffect', /* glsl */ `
      uniform float strength;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 center = vec2(0.5, 0.55);
        vec2 dir = uv - center;
        float edge = smoothstep(0.1, 0.6, length(dir));
        vec3 acc = inputColor.rgb;
        for (int i = 1; i < 8; i++) {
          float t = float(i) / 7.0;
          acc += texture2D(inputBuffer, uv - dir * strength * edge * t).rgb;
        }
        outputColor = vec4(acc / 8.0, inputColor.a);
      }`, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([['strength', new THREE.Uniform(0)]]),
    });
  }
}

/**
 * Analytic sun flare: a soft halo at the sun plus a few ghosts along the
 * line through the screen centre. Fades with `strength` (occlusion / night).
 */
class LensFlareEffect extends Effect {
  constructor() {
    super('LensFlareEffect', /* glsl */ `
      uniform vec2 sun;
      uniform float strength;
      uniform float flareAspect;
      float disc(vec2 p, float r, float soft) { return 1.0 - smoothstep(r - soft, r, length(p)); }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = vec3(0.0);
        if (strength > 0.001) {
          vec2 a = vec2(flareAspect, 1.0);
          vec2 p = (uv - sun) * a;
          c += vec3(1.0, 0.85, 0.65) * 0.18 / (1.0 + dot(p, p) * 60.0);
          vec2 axis = (vec2(0.5) - sun);
          for (int i = 0; i < 5; i++) {
            float k = float(i) * 0.38 + 0.45;
            vec2 g = (uv - (sun + axis * k * 1.6)) * a;
            float s = 0.02 + 0.03 * fract(float(i) * 1.7);
            vec3 tint = mix(vec3(0.5, 0.7, 1.0), vec3(1.0, 0.6, 0.35), fract(float(i) * 0.61));
            c += tint * disc(g, s, s * 0.6) * 0.05;
          }
          // Faint horizontal streak.
          c += vec3(0.9, 0.8, 1.0) * exp(-abs(p.y) * 180.0) * exp(-abs(p.x) * 4.0) * 0.12;
        }
        outputColor = vec4(inputColor.rgb + c * strength, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['sun', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['strength', new THREE.Uniform(0)],
        ['flareAspect', new THREE.Uniform(1)],
      ]),
    });
  }
}
