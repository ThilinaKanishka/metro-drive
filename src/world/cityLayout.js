import { CONFIG } from '../config.js';
import { createRng } from '../core/utils.js';

/**
 * Pure data description of the city: road grid, blocks, buildings, props and
 * colliders. Rendering modules read from this; physics queries colliders.
 *
 * Coordinate system: the city is centred on the origin, roads run along X and Z.
 * Road i (0..blocks) has its centre line at `roadX[i]` / `roadZ[i]`.
 */
export class CityLayout {
  constructor(cfg = CONFIG.city) {
    this.cfg = cfg;
    this.rng = createRng(cfg.seed);
    this.cell = cfg.blockSize + cfg.roadWidth;
    this.extentX = cfg.blocksX * this.cell + cfg.roadWidth;
    this.extentZ = cfg.blocksZ * this.cell + cfg.roadWidth;
    this.halfX = this.extentX / 2;
    this.halfZ = this.extentZ / 2;
    this.laneOffset = cfg.roadWidth / 4; // centre of each lane from road centre line

    this.roadX = [];
    this.roadZ = [];
    for (let i = 0; i <= cfg.blocksX; i++) this.roadX.push(-this.halfX + cfg.roadWidth / 2 + i * this.cell);
    for (let i = 0; i <= cfg.blocksZ; i++) this.roadZ.push(-this.halfZ + cfg.roadWidth / 2 + i * this.cell);

    this.blocks = [];
    this.buildings = [];
    this.trees = [];
    this.streetLights = [];
    // Spatial hash: one collider list per block (border walls handled separately)
    this.blockColliders = [];

    this._generateBlocks();
    this._generateBuildings();
    this._generateProps();
    this._generateBorder();
  }

  // ---------------------------------------------------------------- generation
  _generateBlocks() {
    const { blocksX, blocksZ, blockSize, parkChance } = this.cfg;
    for (let iz = 0; iz < blocksZ; iz++) {
      for (let ix = 0; ix < blocksX; ix++) {
        const cx = this.roadX[ix] + this.cell / 2;
        const cz = this.roadZ[iz] + this.cell / 2;
        // Distance from centre (1 downtown .. 0 edge) drives building height.
        const nx = (ix + 0.5) / blocksX - 0.5;
        const nz = (iz + 0.5) / blocksZ - 0.5;
        const centrality = 1 - Math.min(1, Math.hypot(nx, nz) * 1.6);
        const park = this.rng.chance(parkChance) && centrality < 0.7;
        this.blocks.push({ ix, iz, cx, cz, size: blockSize, park, centrality });
        this.blockColliders.push([]);
      }
    }
  }

  _generateBuildings() {
    const { sidewalkWidth, minBuildingHeight, maxBuildingHeight, downtownFalloff } = this.cfg;
    const rng = this.rng;
    const palette = [
      0xd9cbb3, 0xc7b299, 0xa9b4c2, 0x8fa3b8, 0xe6dccb, 0xb88e72, 0x9aa69a,
      0xcfd6dd, 0x7d8a99, 0xd4a373, 0xbfc9ca, 0xa68a7b, 0xe8e2d6, 0x6f7d8c,
    ];

    this.blocks.forEach((block, bi) => {
      if (block.park) return;
      const inner = block.size - sidewalkWidth * 2;
      const x0 = block.cx - inner / 2;
      const z0 = block.cz - inner / 2;
      const nx = rng.int(1, 3);
      const nz = rng.int(1, 3);
      const lotW = inner / nx;
      const lotD = inner / nz;

      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          // Leave a few lots empty (plazas) for variety.
          if (nx * nz > 2 && rng.chance(0.08)) continue;
          const margin = rng.range(0.6, 2.2);
          const w = lotW - margin * 2;
          const d = lotD - margin * 2;
          const x = x0 + lotW * (i + 0.5);
          const z = z0 + lotD * (j + 0.5);
          const heightScale = Math.pow(Math.max(block.centrality, 0), downtownFalloff * 2) * 0.85 + 0.15;
          const h = minBuildingHeight + rng() * (maxBuildingHeight - minBuildingHeight) * heightScale;
          const color = rng.pick(palette);
          this.buildings.push({ x, z, w, d, h, y: 0, color });
          this._addBox(bi, x, z, w, d);

          // Occasionally put a slimmer tower on top of a podium.
          if (h > 24 && rng.chance(0.3)) {
            const tw = w * rng.range(0.5, 0.75);
            const td = d * rng.range(0.5, 0.75);
            const th = h * rng.range(0.4, 0.9);
            this.buildings.push({ x, z, w: tw, d: td, h: th, y: h, color: rng.pick(palette) });
          }
        }
      }
    });
  }

  _generateProps() {
    const { sidewalkWidth, treeSpacing, streetLightSpacing, blockSize } = this.cfg;
    const rng = this.rng;
    const half = blockSize / 2;

    this.blocks.forEach((block, bi) => {
      // Walk the four sides of the block's sidewalk. (nx, nz) = outward normal.
      const sides = [
        { nx: 0, nz: -1 }, { nx: 0, nz: 1 }, { nx: -1, nz: 0 }, { nx: 1, nz: 0 },
      ];
      for (const s of sides) {
        // Tangent along the side.
        const tx = s.nz !== 0 ? 1 : 0;
        const tz = s.nx !== 0 ? 1 : 0;
        const usable = blockSize - 8; // keep corners clear for visibility

        // Street lights: the lamp arm points toward the road (outward normal).
        const nLights = Math.max(1, Math.floor(usable / streetLightSpacing));
        for (let k = 0; k <= nLights; k++) {
          // Stagger opposite sides so lights don't line up exactly.
          if ((s.nx + s.nz > 0) === (k % 2 === 0)) continue;
          const t = -usable / 2 + (usable * k) / nLights;
          const x = block.cx + s.nx * (half - 0.4) + tx * t;
          const z = block.cz + s.nz * (half - 0.4) + tz * t;
          this.streetLights.push({ x, z, nx: s.nx, nz: s.nz });
          this._addCircle(bi, x, z, 0.18);
        }

        // Trees along the sidewalk.
        if (!block.park) {
          const nTrees = Math.floor(usable / treeSpacing);
          for (let k = 0; k < nTrees; k++) {
            if (rng.chance(0.25)) continue;
            const t = -usable / 2 + treeSpacing * (k + 0.5) + rng.range(-1, 1);
            const x = block.cx + s.nx * (half - sidewalkWidth * 0.55) + tx * t;
            const z = block.cz + s.nz * (half - sidewalkWidth * 0.55) + tz * t;
            this.trees.push({ x, z, scale: rng.range(0.8, 1.2), hue: rng() });
            this._addCircle(bi, x, z, 0.35);
          }
        }
      }

      // Parks: scatter trees across the lawn.
      if (block.park) {
        const inner = blockSize - sidewalkWidth * 2 - 4;
        const count = rng.int(14, 24);
        for (let k = 0; k < count; k++) {
          const x = block.cx + rng.range(-inner / 2, inner / 2);
          const z = block.cz + rng.range(-inner / 2, inner / 2);
          this.trees.push({ x, z, scale: rng.range(0.9, 1.6), hue: rng() });
          this._addCircle(bi, x, z, 0.4);
        }
      }
    });

    // Decorative trees outside the city walls (no colliders needed).
    this.outerTrees = [];
    for (let k = 0; k < 600 && this.outerTrees.length < 320; k++) {
      const x = rng.range(-this.halfX - 150, this.halfX + 150);
      const z = rng.range(-this.halfZ - 150, this.halfZ + 150);
      if (Math.abs(x) < this.halfX + 10 && Math.abs(z) < this.halfZ + 10) continue;
      this.outerTrees.push({ x, z, scale: rng.range(1.0, 2.2), hue: rng() });
    }
  }

  _generateBorder() {
    const t = 1; // wall thickness
    const hx = this.halfX + 1.5;
    const hz = this.halfZ + 1.5;
    this.borderHalf = { x: hx, z: hz };
    this.borderWalls = [
      { minX: -hx - t, maxX: hx + t, minZ: -hz - t, maxZ: -hz },
      { minX: -hx - t, maxX: hx + t, minZ: hz, maxZ: hz + t },
      { minX: -hx - t, maxX: -hx, minZ: -hz, maxZ: hz },
      { minX: hx, maxX: hx + t, minZ: -hz, maxZ: hz },
    ].map((b) => ({ type: 'box', ...b }));
  }

  _addBox(bi, x, z, w, d) {
    this.blockColliders[bi].push({
      type: 'box', minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2,
    });
  }

  _addCircle(bi, x, z, r) {
    this.blockColliders[bi].push({ type: 'circle', x, z, r });
  }

  // ------------------------------------------------------------------ queries
  /** Block grid coordinates containing the point (may be outside the grid). */
  blockCoords(x, z) {
    return {
      ix: Math.floor((x - this.roadX[0]) / this.cell),
      iz: Math.floor((z - this.roadZ[0]) / this.cell),
    };
  }

  /** Collect static colliders near a world position (3x3 blocks + border). */
  collidersNear(x, z, out = []) {
    out.length = 0;
    const { ix, iz } = this.blockCoords(x, z);
    const { blocksX, blocksZ } = this.cfg;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bx = ix + dx;
        const bz = iz + dz;
        if (bx < 0 || bz < 0 || bx >= blocksX || bz >= blocksZ) continue;
        const list = this.blockColliders[bz * blocksX + bx];
        for (let k = 0; k < list.length; k++) out.push(list[k]);
      }
    }
    for (const w of this.borderWalls) out.push(w);
    return out;
  }

  /**
   * Nearest point on any road centre line plus the road's axis there.
   * Used by the reset key.
   */
  nearestRoad(x, z) {
    const cx = Math.max(this.roadX[0], Math.min(this.roadX[this.roadX.length - 1], x));
    const cz = Math.max(this.roadZ[0], Math.min(this.roadZ[this.roadZ.length - 1], z));
    let best = { d: Infinity };
    for (const rx of this.roadX) {
      const d = Math.abs(x - rx);
      if (d < best.d) best = { d, x: rx, z: cz, axis: 'z' };
    }
    for (const rz of this.roadZ) {
      const d = Math.abs(z - rz);
      if (d < best.d) best = { d, x: cx, z: rz, axis: 'x' };
    }
    return best;
  }
}
