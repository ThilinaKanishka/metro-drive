import * as THREE from 'three';

/**
 * Tileable value-noise texture, generated once. Each channel is a different
 * frequency (R: broad blotches, G: medium, B: fine grain), so one texture
 * fetch gives several independent masks: road macro variation, worn paint,
 * puddles, dirt.
 */
let noiseTexture = null;

export function getNoiseTexture() {
  if (noiseTexture) return noiseTexture;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const layer = (cells, seed) => {
    // Random lattice, wrapped so the texture tiles seamlessly.
    const lat = new Float32Array(cells * cells);
    let s = seed;
    for (let i = 0; i < lat.length; i++) {
      s = (s * 16807) % 2147483647;
      lat[i] = s / 2147483647;
    }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const v = (i, j) => lat[((j + cells) % cells) * cells + ((i + cells) % cells)];
        const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
        const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
        out[y * size + x] = a + (b - a) * sy;
      }
    }
    return out;
  };
  const fbm = (base, seed) => {
    const acc = new Float32Array(size * size);
    let amp = 0.5;
    let total = 0;
    for (let o = 0; o < 4; o++) {
      const l = layer(base << o, seed + o * 101);
      for (let i = 0; i < acc.length; i++) acc[i] += l[i] * amp;
      total += amp;
      amp *= 0.5;
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= total;
    return acc;
  };
  const r = fbm(4, 11);
  const g = fbm(8, 23);
  const b = fbm(32, 37);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r[i] * 255;
    data[i * 4 + 1] = g[i] * 255;
    data[i * 4 + 2] = b[i] * 255;
    data[i * 4 + 3] = 255;
  }
  noiseTexture = new THREE.DataTexture(data, size, size);
  noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
  noiseTexture.magFilter = THREE.LinearFilter;
  noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTexture.generateMipmaps = true;
  noiseTexture.needsUpdate = true;
  return noiseTexture;
}
