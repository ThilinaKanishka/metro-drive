import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { createRng } from '../core/utils.js';

/**
 * Street furniture: bus stops, benches, trash bins, shop signs with awnings
 * on street-facing facades, and park paths with fountains.
 *
 * Placement uses its own RNG (the city layout is unchanged) and checks the
 * block's existing colliders (trees, lamps, signal poles) and parked cars.
 * Every prop type is one InstancedMesh of a merged, vertex-coloured geometry
 * (signs and park paths are single merged meshes), ~10 draw calls in all.
 * Props register colliders for the player and idle spots for pedestrians.
 */
const UP = new THREE.Vector3(0, 1, 0);

/** Position + normal only, plus a flat vertex colour. */
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const box = (w, h, d, x, y, z, hex) => colored(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
const cyl = (r, h, x, y, z, hex, seg = 10) => colored(new THREE.CylinderGeometry(r, r, h, seg).translate(x, y, z), hex);

// Prop geometry in local space: +Z faces the road (or the path).
function busStopGeometry() {
  const frame = 0x2b2f36;
  const roof = 0x3a6fb0;
  const parts = [box(3.9, 0.1, 1.6, 0, 2.45, 0, roof)];
  for (const x of [-1.8, 1.8]) for (const z of [-0.62, 0.62]) parts.push(box(0.08, 2.4, 0.08, x, 1.2, z, frame));
  parts.push(box(2.4, 0.08, 0.42, 0, 0.48, -0.35, 0x8a5a3c), box(2.2, 0.4, 0.06, 0, 0.3, -0.5, frame));
  // Bus stop sign at the kerb.
  parts.push(box(0.07, 2.7, 0.07, -2.4, 1.35, 2.0, frame), box(0.55, 0.55, 0.05, -2.4, 2.55, 2.0, 0x2f6fd6), box(0.35, 0.12, 0.06, -2.4, 2.62, 2.0, 0xffffff));
  return {
    frame: mergeGeometries(parts),
    glass: mergeGeometries([box(3.6, 1.9, 0.04, 0, 1.3, -0.62, 0xffffff), box(0.04, 1.9, 1.15, 1.8, 1.3, 0, 0xffffff), box(0.04, 1.9, 1.15, -1.8, 1.3, 0, 0xffffff)]),
  };
}

function benchGeometry() {
  const wood = 0x8a5a3c;
  const metal = 0x2b2e33;
  return mergeGeometries([
    box(1.7, 0.07, 0.45, 0, 0.45, 0, wood),
    box(1.7, 0.38, 0.06, 0, 0.74, -0.21, wood),
    box(0.07, 0.45, 0.45, -0.75, 0.22, 0, metal),
    box(0.07, 0.45, 0.45, 0.75, 0.22, 0, metal),
  ]);
}

function binGeometry() {
  return mergeGeometries([
    cyl(0.25, 0.85, 0, 0.425, 0, 0x2f5e3a),
    cyl(0.27, 0.07, 0, 0.88, 0, 0x22262c),
  ]);
}

function fountainGeometry() {
  const stone = 0xb8b2a6;
  return mergeGeometries([
    colored(new THREE.CylinderGeometry(2.3, 2.45, 0.55, 20).translate(0, 0.27, 0), stone),
    colored(new THREE.CylinderGeometry(2.05, 2.05, 0.04, 20).translate(0, 0.46, 0), 0x4f8fc8),
    cyl(0.25, 1.4, 0, 0.9, 0, stone),
    colored(new THREE.CylinderGeometry(0.8, 0.35, 0.3, 14).translate(0, 1.65, 0), stone),
    colored(new THREE.CylinderGeometry(0.7, 0.7, 0.03, 14).translate(0, 1.79, 0), 0x6aa8dc),
  ]);
}

export class StreetProps {
  constructor(scene, layout) {
    this.layout = layout;
    this.cfg = CONFIG.props;
    this.rng = createRng(this.cfg.seed);
    this.half = layout.cfg.blockSize / 2;
    this.sw = layout.cfg.sidewalkWidth;
    this.busStops = [];
    this.benches = [];
    this.bins = [];
    this.fountains = [];
    this.signs = [];
    this.paths = [];
    this.idleSpots = [];

    this._placeSidewalkProps();
    this._placeShopSigns();
    this._placeParks();
    // Pedestrians read layout.idleSpots (bus stops + shop fronts).
    layout.idleSpots = this.idleSpots;

    this.group = new THREE.Group();
    this.group.name = 'streetProps';
    this._build();
    scene.add(this.group);
  }

  // ------------------------------------------------------------ placement
  /** Is a circle at (x, z) clear of the block's colliders and props placed so far? */
  _free(bi, x, z, r) {
    for (const c of this.layout.blockColliders[bi]) {
      if (c.type === 'circle') {
        if (Math.hypot(c.x - x, c.z - z) < r + c.r) return false;
      } else if (x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) {
        return false;
      }
    }
    return true;
  }

  _parkedNear(x, z, r) {
    return (this.layout.parked || []).some((v) => Math.abs(v.x - x) < r && Math.abs(v.z - z) < r);
  }

  /** World position of a sidewalk point: side normal (nx, nz), offset in from the kerb, t along. */
  _side(b, nx, nz, off, t) {
    return [b.cx + nx * (this.half - off) + (nz !== 0 ? t : 0), b.cz + nz * (this.half - off) + (nx !== 0 ? t : 0)];
  }

  _addBoxCollider(bi, x, z, w, d, yaw) {
    // Props are axis aligned (yaw is a multiple of 90 degrees).
    const swap = Math.abs(Math.sin(yaw)) > 0.5;
    this.layout._addBox(bi, x, z, swap ? d : w, swap ? w : d);
  }

  _placeSidewalkProps() {
    const rng = this.rng;
    const L = this.layout;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    L.blocks.forEach((b, bi) => {
      for (const [nx, nz] of sides) {
        // Facing the road: local +Z = outward normal.
        const yaw = Math.atan2(nx, nz);
        if (!b.park && rng.chance(this.cfg.busStopChance)) {
          for (let k = 0; k < 8; k++) {
            const t = rng.range(-16, 16);
            const [x, z] = this._side(b, nx, nz, 2.6, t);
            const [kx, kz] = this._side(b, nx, nz, 0.4, t);
            if (!this._free(bi, x, z, 2.2) || this._parkedNear(kx, kz, 9)) continue;
            this.busStops.push({ x, z, yaw });
            this._addBoxCollider(bi, x, z, 3.9, 1.4, yaw);
            // Sign pole at local (-2.4, 2.0) -> world (rotation about Y by yaw).
            const c = Math.cos(yaw);
            const s = Math.sin(yaw);
            L._addCircle(bi, x - 2.4 * c + 2.0 * s, z + 2.4 * s + 2.0 * c, 0.12);
            for (const dt of [-1, -0.2, 0.7]) {
              const [ix, iz] = this._side(b, nx, nz, 2.1, t + dt);
              this.idleSpots.push({ x: ix, z: iz, yaw, kind: 'bus', block: bi });
            }
            break;
          }
        }
        if (rng.chance(this.cfg.benchChance)) {
          for (let k = 0; k < 6; k++) {
            const t = rng.range(-20, 20);
            const [x, z] = this._side(b, nx, nz, 3.1, t);
            if (!this._free(bi, x, z, 1.0)) continue;
            this.benches.push({ x, z, yaw });
            this._addBoxCollider(bi, x, z, 1.7, 0.5, yaw);
            this.idleSpots.push({ x, z, yaw, kind: 'bench', block: bi });
            break;
          }
        }
        if (rng.chance(this.cfg.binChance)) {
          for (let k = 0; k < 6; k++) {
            const t = rng.range(-21, 21);
            const [x, z] = this._side(b, nx, nz, 0.75, t);
            if (!this._free(bi, x, z, 0.5)) continue;
            this.bins.push({ x, z, yaw });
            L._addCircle(bi, x, z, 0.28);
            break;
          }
        }
      }
    });
  }

  /** Signs + awnings over the ground floor of buildings that face a street. */
  _placeShopSigns() {
    const rng = this.rng;
    const L = this.layout;
    const inner = this.half - this.sw;
    for (const bld of L.buildings) {
      if (bld.y > 0) continue;
      const { ix, iz } = L.blockCoords(bld.x, bld.z);
      const bi = iz * L.cfg.blocksX + ix;
      const blk = L.blocks[bi];
      if (!blk || blk.park) continue;
      const faces = [
        [1, 0, bld.x + bld.w / 2, bld.z, bld.d],
        [-1, 0, bld.x - bld.w / 2, bld.z, bld.d],
        [0, 1, bld.x, bld.z + bld.d / 2, bld.w],
        [0, -1, bld.x, bld.z - bld.d / 2, bld.w],
      ];
      for (const [nx, nz, fx, fz, width] of faces) {
        // Distance from this facade to the inner edge of the sidewalk.
        const facadeOff = nx !== 0 ? nx * (fx - blk.cx) : nz * (fz - blk.cz);
        const gap = inner - facadeOff;
        if (gap < -0.1 || gap > 2.6 || width < 4) continue;
        if (!rng.chance(this.cfg.shopSignChance)) continue;
        const w = Math.min(width * 0.7, 7);
        const name = rng.int(0, this.cfg.shopNames.length - 1);
        const color = rng.pick([0xc0392b, 0x1f6fb2, 0x2e8b57, 0x8e44ad, 0xd35400, 0x34495e, 0xb7950b, 0xc2185b]);
        this.signs.push({ x: fx + nx * 0.06, z: fz + nz * 0.06, nx, nz, w, name, color });
        // A spot on the sidewalk in front of the shop window.
        const sx = fx + nx * (gap + 0.6);
        const sz = fz + nz * (gap + 0.6);
        this.idleSpots.push({ x: sx, z: sz, yaw: Math.atan2(-nx, -nz), kind: 'shop', block: bi });
      }
    }
  }

  _placeParks() {
    const L = this.layout;
    const lawn = L.cfg.blockSize - this.sw * 2;
    L.blocks.forEach((b, bi) => {
      if (!b.park) return;
      this.paths.push({ x: b.cx, z: b.cz, w: lawn, d: 2.4 }, { x: b.cx, z: b.cz, w: 2.4, d: lawn });
      this.fountains.push({ x: b.cx, z: b.cz });
      L._addCircle(bi, b.cx, b.cz, 2.45);
      // Benches facing the paths, a little way out from the fountain.
      for (const [dx, dz, yaw] of [[7, 2.1, Math.PI], [-7, -2.1, 0], [2.1, -7, -Math.PI / 2], [-2.1, 7, Math.PI / 2], [15, -2.1, 0], [-15, 2.1, Math.PI]]) {
        const x = b.cx + dx;
        const z = b.cz + dz;
        if (!this._free(bi, x, z, 1.0)) continue;
        this.benches.push({ x, z, yaw });
        this._addBoxCollider(bi, x, z, 1.7, 0.5, yaw);
        this.idleSpots.push({ x, z, yaw, kind: 'bench', block: bi });
      }
    });
  }

  // ------------------------------------------------------------- meshes
  _instanced(geo, material, items, shadow = true) {
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(items.length, 1));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const y = this.layout.cfg.sidewalkHeight;
    items.forEach((it, i) => mesh.setMatrixAt(i, m.compose(p.set(it.x, y, it.z), q.setFromAxisAngle(UP, it.yaw ?? 0), s)));
    mesh.count = items.length;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  _build() {
    const vc = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    const bus = busStopGeometry();
    this._instanced(bus.frame, vc, this.busStops);
    this._instanced(bus.glass, new THREE.MeshStandardMaterial({
      color: 0x9fc4dc, transparent: true, opacity: 0.32, roughness: 0.1, depthWrite: false,
    }), this.busStops, false);
    this.adMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: makeAdTexture(), emissive: 0xffffff, emissiveIntensity: 0.15 });
    this.adMat.emissiveMap = this.adMat.map;
    this._instanced(adGeometry(), this.adMat, this.busStops, false);
    this._instanced(benchGeometry(), vc, this.benches);
    this._instanced(binGeometry(), vc, this.bins);
    this._instanced(fountainGeometry(), vc, this.fountains);

    // Park paths: one merged mesh just above the lawn.
    if (this.paths.length) {
      const y = this.layout.cfg.sidewalkHeight + 0.05;
      const geo = mergeGeometries(this.paths.map((p) => box(p.w, 0.03, p.d, p.x, y, p.z, 0xcfc6ad)));
      const mesh = new THREE.Mesh(geo, vc);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Shop signs: atlas-textured faces + coloured boards and awnings.
    if (this.signs.length) {
      const names = this.cfg.shopNames;
      const cols = 4;
      const rows = Math.ceil(names.length / cols);
      const atlas = makeSignAtlas(names, cols, rows);
      const faces = [];
      const boards = [];
      for (const s of this.signs) {
        const yaw = Math.atan2(s.nx, s.nz);
        const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(1, 1, 1));
        const face = new THREE.PlaneGeometry(s.w - 0.2, 0.75).translate(0, 3.15, 0.08);
        // Map the plane's UVs into this shop's atlas cell.
        const uv = face.getAttribute('uv');
        const cx = s.name % cols;
        const cy = Math.floor(s.name / cols);
        for (let i = 0; i < uv.count; i++) {
          uv.setXY(i, (cx + uv.getX(i)) / cols, 1 - (cy + 1 - uv.getY(i)) / rows);
        }
        faces.push(face.applyMatrix4(m));
        boards.push(
          box(s.w, 0.95, 0.12, 0, 3.15, 0.0, s.color).applyMatrix4(m),
          colored(new THREE.BoxGeometry(s.w, 0.06, 1.1).rotateX(0.28).translate(0, 2.62, 0.5), s.color).applyMatrix4(m),
        );
      }
      this.signMat = new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.6 });
      const signMesh = new THREE.Mesh(mergeGeometries(faces), this.signMat);
      const boardMesh = new THREE.Mesh(mergeGeometries(boards), vc);
      boardMesh.castShadow = true;
      boardMesh.receiveShadow = true;
      this.group.add(signMesh, boardMesh);
    }
  }

  /** Light up shop signs and bus stop adverts at night. */
  update(night) {
    const on = THREE.MathUtils.smoothstep(night, 0.25, 0.6);
    if (this.signMat) this.signMat.emissiveIntensity = 0.05 + on * 1.1;
    this.adMat.emissiveIntensity = 0.15 + on * 1.2;
  }
}

/** Advert panel (keeps its UVs for the poster texture). */
function adGeometry() {
  const g = new THREE.BoxGeometry(1.0, 1.5, 0.05).translate(1.15, 1.3, -0.58);
  return g.toNonIndexed();
}

function makeSignAtlas(names, cols, rows) {
  const cw = 256;
  const ch = 80;
  const c = document.createElement('canvas');
  c.width = cw * cols;
  c.height = ch * rows;
  const ctx = c.getContext('2d');
  names.forEach((name, i) => {
    const x = (i % cols) * cw;
    const y = Math.floor(i / cols) * ch;
    ctx.fillStyle = '#f6f1e4';
    ctx.fillRect(x, y, cw, ch);
    ctx.fillStyle = ['#c0392b', '#1f6fb2', '#2e8b57', '#8e44ad', '#d35400', '#222'][i % 6];
    ctx.font = '800 46px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, x + cw / 2, y + ch / 2 + 2, cw - 20);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeAdTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 96;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 96);
  g.addColorStop(0, '#ff7a59');
  g.addColorStop(1, '#6a3fd0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 96);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '800 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('METRO', 32, 40);
  ctx.fillText('DRIVE', 32, 58);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
