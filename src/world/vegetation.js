import * as THREE from 'three';
import { assets } from '../core/assets.js';
import { createRng } from '../core/utils.js';
import { chunkedInstances } from './chunks.js';
import { addWind } from './trees.js';

const TREE_NEAR = 170;     // Kenney tree models within this distance, procedural beyond
const GRASS_DISTANCE = 90;
const BUSH_DISTANCE = 220;

/**
 * Detailed vegetation from the Kenney Nature Kit (CC0):
 *  - near-LOD trees: chunks close to the camera swap the low-poly procedural
 *    trees for the Kenney models (vertex-coloured, wind-swayed)
 *  - parks: bushes, grass tufts and flower beds around the paths, and a low
 *    fence around the lawn (with gaps for the paths)
 * Small foliage is distance-culled per chunk and casts no shadows.
 * Without the models, only the procedural trees remain.
 */
export class Vegetation {
  constructor(scene, layout, proceduralTrees) {
    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    this.layout = layout;
    this.procedural = proceduralTrees;
    this.chunks = new Map();   // key -> { center, near: [], far: [] }
    const n = assets.models?.nature ?? {};
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
    addWind(this.material, 0.8);
    this.staticMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });

    this.foliage = true;
    for (const mesh of proceduralTrees.userData.city.children.flatMap((g) => g.children)) this._chunk(mesh.userData.chunk, mesh, 'far');
    if (n.tree_default) this._buildTrees(n);
    this.details = [];
    this._buildParks(n);
    scene.add(this.group);
  }

  _chunk(key, mesh, kind) {
    if (!this.chunks.has(key)) this.chunks.set(key, { center: mesh.boundingSphere.center.clone(), near: [], far: [] });
    this.chunks.get(key)[kind].push(mesh);
  }

  /**
   * Normalised model geometry: base at y = 0, `height` metres tall, with the
   * kit's stylised mint greens pulled toward natural foliage colours.
   */
  _fit(geo, height) {
    const g = geo.clone();
    const col = g.getAttribute('color');
    if (col) {
      const c = new THREE.Color();
      const hsl = {};
      for (let i = 0; i < col.count; i++) {
        c.fromBufferAttribute(col, i).getHSL(hsl);
        // Greens / cyans (hue 0.25-0.55): toward yellow-green, less saturated, darker.
        if (hsl.h > 0.2 && hsl.h < 0.58) c.setHSL(0.22 + (hsl.h - 0.2) * 0.25, hsl.s * 0.7, hsl.l * 0.75);
        col.setXYZ(i, c.r, c.g, c.b);
      }
    }
    g.computeBoundingBox();
    const b = g.boundingBox;
    const k = height / (b.max.y - b.min.y);
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2).scale(k, k, k);
    return g;
  }

  _buildTrees(n) {
    const { rounds, cones } = this.procedural.userData.items;
    const roundModels = ['tree_default', 'tree_oak', 'tree_detailed', 'tree_fat'].filter((k) => n[k]).map((k) => this._fit(n[k], 6.2));
    const coneModels = ['tree_pineRoundB', 'tree_pineTallA'].filter((k) => n[k]).map((k) => this._fit(n[k], 7.5));
    const place = (items, models) => {
      const per = models.map(() => []);
      for (const it of items) {
        const pick = Math.floor(Math.abs(Math.sin(it.x * 12.9 + it.z * 7.3)) * models.length) % models.length;
        per[pick].push(it);
      }
      models.forEach((geo, k) => {
        const g = chunkedInstances(geo, this.material, per[k], {
          chunk: 200, // same grid as the procedural trees
          onMesh: (mesh) => {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this._chunk(mesh.userData.chunk, mesh, 'near');
          },
        });
        this.group.add(g);
      });
    };
    if (roundModels.length) place(rounds, roundModels);
    if (coneModels.length) place(cones, coneModels);
  }

  _buildParks(n) {
    const L = this.layout;
    const rng = createRng(L.cfg.seed + 313);
    const sw = L.cfg.sidewalkWidth;
    const inner = L.cfg.blockSize - sw * 2;
    const y = L.cfg.sidewalkHeight + 0.04;
    const items = { bush: [], bushL: [], grass: [], flowers: [], fence: [] };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const put = (list, x, z, s, yaw = rng() * 6.28) => list.push({
      x, z, matrix: m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, yaw), new THREE.Vector3(s, s, s)).clone(),
    });
    for (const b of L.blocks) {
      if (!b.park) continue;
      const h = inner / 2 - 1;
      // Avoid the cross paths (±1.6 m) and the fountain (r 3.5 m).
      const free = (x, z) => Math.abs(x - b.cx) > 2.2 && Math.abs(z - b.cz) > 2.2 && Math.hypot(x - b.cx, z - b.cz) > 4.5;
      for (let k = 0; k < 40; k++) {
        const x = b.cx + rng.range(-h, h);
        const z = b.cz + rng.range(-h, h);
        if (free(x, z)) put(rng.chance(0.3) ? items.bushL : items.bush, x, z, rng.range(0.8, 1.3));
      }
      for (let k = 0; k < 160; k++) {
        const x = b.cx + rng.range(-h, h);
        const z = b.cz + rng.range(-h, h);
        if (free(x, z)) put(items.grass, x, z, rng.range(0.7, 1.4));
      }
      // Flower beds along the paths.
      for (let k = 0; k < 48; k++) {
        const along = rng.range(5, h);
        const side = rng.chance(0.5) ? 1 : -1;
        const off = side * rng.range(1.9, 2.6);
        const sign = rng.chance(0.5) ? 1 : -1;
        const alongX = rng.chance(0.5);
        put(items.flowers, b.cx + (alongX ? along * sign : off), b.cz + (alongX ? off : along * sign), rng.range(0.8, 1.2));
      }
      // Fence segments around the lawn, leaving gaps where the paths meet the sidewalk.
      const seg = 2;
      for (let t = -inner / 2 + seg / 2; t < inner / 2; t += seg) {
        if (Math.abs(t) < 2.5) continue;
        for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = b.cx + nx * (inner / 2 - 0.2) + (nz !== 0 ? t : 0);
          const z = b.cz + nz * (inner / 2 - 0.2) + (nx !== 0 ? t : 0);
          put(items.fence, x, z, 1, nz !== 0 ? 0 : Math.PI / 2);
        }
      }
    }
    const add = (key, geo, list, dist, shadow) => {
      if (!geo || !list.length) return;
      const g = chunkedInstances(geo, key === 'fence' ? this.staticMat : this.material, list, {
        chunk: 70,
        onMesh: (mesh) => {
          mesh.castShadow = shadow;
          mesh.receiveShadow = true;
          mesh.userData.maxDist = dist;
          this.details.push(mesh);
        },
      });
      this.group.add(g);
    };
    add('bush', n.plant_bush && this._fit(n.plant_bush, 0.9), items.bush, BUSH_DISTANCE, false);
    add('bushL', n.plant_bushLarge && this._fit(n.plant_bushLarge, 1.4), items.bushL, BUSH_DISTANCE, true);
    add('grass', n.grass && this._fit(n.grass, 0.35), items.grass, GRASS_DISTANCE, false);
    if (n.flower_redA) {
      const beds = [n.flower_redA, n.flower_yellowA, n.flower_purpleA].filter(Boolean).map((g) => this._fit(g, 0.4));
      beds.forEach((geo, k) => add('flowers', geo, items.flowers.filter((_, i) => i % beds.length === k), GRASS_DISTANCE, false));
    }
    if (n.fence_simple) {
      const f = n.fence_simple.clone();
      f.computeBoundingBox();
      const b = f.boundingBox;
      const len = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
      const k = 2 / len;
      f.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2).scale(k, 0.9 * k, k);
      add('fence', f, items.fence, BUSH_DISTANCE, false);
    }
  }

  /** Quality: detailed trees and small foliage on / off (Low turns them off). */
  setFoliage(on) {
    this.foliage = on;
  }

  /** Per frame: tree LOD per chunk, distance culling of small foliage. */
  update(eye) {
    for (const ch of this.chunks.values()) {
      const near = this.foliage && ch.near.length > 0 && Math.hypot(ch.center.x - eye.x, ch.center.z - eye.z) < TREE_NEAR;
      for (const m of ch.near) m.visible = near;
      for (const m of ch.far) m.visible = !near;
    }
    for (const m of this.details) {
      const c = m.boundingSphere.center;
      m.visible = this.foliage && Math.hypot(c.x - eye.x, c.z - eye.z) < m.userData.maxDist + m.boundingSphere.radius;
    }
  }
}
