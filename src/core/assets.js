import * as THREE from 'three';

/**
 * Asset loading. Everything goes through one LoadingManager so the loading
 * screen can show overall progress. Anything that fails to load is simply
 * missing from the registry and its consumer falls back to the procedural
 * version (textures: flat colours, models: procedural meshes).
 *
 * Usage: await loadAssets(onProgress) once at startup, then read `assets`.
 */
export const assets = {
  textures: {},      // name -> { color, normal, rough } (THREE.Texture each, or missing)
  models: {},        // filled in by the model loader (see models.js)
  failed: [],
};

export const manager = new THREE.LoadingManager();
const BASE = import.meta.env.BASE_URL || '/';

const TEXTURE_SETS = {
  asphalt: ['color', 'normal', 'rough'],
  sidewalk: ['color', 'normal', 'rough'],
  brick: ['color', 'normal', 'rough'],
  concrete: ['color', 'normal', 'rough'],
  grass: ['color', 'normal'],
};

export function loadTexture(url, srgb) {
  return new Promise((resolve) => {
    new THREE.TextureLoader(manager).load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = 8;
        resolve(tex);
      },
      undefined,
      () => {
        assets.failed.push(url);
        resolve(null);
      },
    );
  });
}

/** Load every texture set; resolves when all have loaded or failed. */
export async function loadTextures() {
  const jobs = [];
  for (const [name, kinds] of Object.entries(TEXTURE_SETS)) {
    const set = (assets.textures[name] = {});
    for (const kind of kinds) {
      jobs.push(loadTexture(`${BASE}textures/${name}_${kind}.jpg`, kind === 'color').then((t) => {
        if (t) set[kind] = t;
      }));
    }
  }
  await Promise.all(jobs);
}

/**
 * A texture set cloned with its own repeat (textures are shared GPU images;
 * clones only differ in their transform). Returns {} if the set is missing.
 */
export function textureSet(name, repeatX = 1, repeatY = repeatX) {
  const src = assets.textures[name] || {};
  const out = {};
  for (const k in src) {
    const t = src[k].clone();
    t.repeat.set(repeatX, repeatY);
    t.needsUpdate = true;
    out[k] = t;
  }
  return out;
}
