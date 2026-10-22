import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assets, manager } from './assets.js';
import { getVehicleShape, registerModelShape, setModelWheel } from '../vehicle/vehicleShapes.js';

/**
 * glTF models (CC0, see CREDITS.md), Draco-compressed, loaded at startup:
 *  - Kenney Car Kit: converted into the game's vehicle-shape format so the
 *    player car, the garage and AI traffic (BatchedMesh) all use them. Each
 *    model is split by the palette cell its triangles sample into clear-coat
 *    paint (recolourable), glass, chrome and vertex-coloured trim; lamp
 *    positions are found from the light-coloured triangles; the toy-like
 *    proportions are stretched to real-world dimensions.
 *  - Kenney Blocky Characters: rigid node animation converted into one
 *    SkinnedMesh per character (one draw call) driven by AnimationMixer.
 *  - Kenney Nature / City Kit Roads: trees, bushes, grass, flowers, fences,
 *    road signs; baked to single vertex-coloured geometries for instancing.
 *
 * Anything that fails to load keeps its procedural fallback.
 */
const BASE = import.meta.env.BASE_URL || '/';

// Kenney model -> game shape name, target size (length, width, height) and procedural fallback.
const CAR_MODELS = {
  hatchback: { file: 'hatchback-sports', size: [3.96, 1.8, 1.5], fallback: 'hatchback' },
  sedan: { file: 'sedan', size: [4.5, 1.88, 1.48], fallback: 'sedan' },
  sports: { file: 'sedan-sports', size: [4.5, 2.0, 1.3], fallback: 'sports' },
  suv: { file: 'suv', size: [4.8, 2.02, 1.85], fallback: 'suv' },
  pickup: { file: 'truck', size: [5.4, 2.04, 1.9], fallback: 'pickup' },
  taxi: { file: 'taxi', size: [4.5, 1.88, 1.62], fallback: 'taxi' },
  van: { file: 'van', size: [5.0, 2.0, 2.1], fallback: 'suv' },
  'suv-luxury': { file: 'suv-luxury', size: [4.9, 2.0, 1.8], fallback: 'suv' },
  police: { file: 'police', size: [4.6, 1.9, 1.6], fallback: 'sedan' },
  ambulance: { file: 'ambulance', size: [5.6, 2.15, 2.5], fallback: 'truck' },
  delivery: { file: 'delivery', size: [6.2, 2.3, 2.8], fallback: 'truck' },
  'truck-flat': { file: 'truck-flat', size: [6.5, 2.3, 2.4], fallback: 'truck' },
  'garbage-truck': { file: 'garbage-truck', size: [7.2, 2.45, 3.1], fallback: 'truck' },
};
const CHARACTERS = 'abcdefghijklmnopqr'.split('');
const NATURE = ['tree_default', 'tree_oak', 'tree_detailed', 'tree_fat', 'tree_pineRoundB', 'tree_pineTallA',
  'plant_bush', 'plant_bushLarge', 'plant_bushDetailed', 'grass', 'grass_large', 'flower_redA', 'flower_yellowA', 'flower_purpleA', 'fence_simple'];
const PROPS = ['road-sign-street'];

let loader = null;
function getLoader() {
  if (loader) return loader;
  const draco = new DRACOLoader(manager);
  draco.setDecoderPath(`${BASE}draco/`);
  loader = new GLTFLoader(manager);
  loader.setDRACOLoader(draco);
  return loader;
}

function load(url) {
  return new Promise((resolve) => {
    getLoader().load(url, resolve, undefined, () => {
      assets.failed.push(url);
      resolve(null);
    });
  });
}

/** Load and convert every model. Resolves when all are done (or failed). */
export async function loadModels() {
  const models = (assets.models = { characters: [], nature: {}, props: {} });
  const jobs = [];
  jobs.push(load(`${BASE}models/cars/wheel-default.glb`).then((g) => g && setModelWheel(convertWheel(g))));
  for (const [name, def] of Object.entries(CAR_MODELS)) {
    jobs.push(load(`${BASE}models/cars/${def.file}.glb`).then((g) => {
      if (!g) return;
      try {
        registerModelShape(name, convertCar(g, def));
      } catch (e) {
        console.warn(`Car model ${def.file} could not be converted, using procedural`, e);
      }
    }));
  }
  CHARACTERS.forEach((c) => jobs.push(load(`${BASE}models/characters/character-${c}.glb`).then((g) => {
    if (g) models.characters.push(convertCharacter(g, c));
  })));
  for (const n of NATURE) jobs.push(load(`${BASE}models/nature/${n}.glb`).then((g) => { if (g) models.nature[n] = bakeStatic(g); }));
  for (const n of PROPS) jobs.push(load(`${BASE}models/props/${n}.glb`).then((g) => { if (g) models.props[n] = bakeStatic(g); }));
  await Promise.all(jobs);
  models.characters.sort((a, b) => a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ helpers
/** Pixels of a texture image (for palette sampling). */
function imagePixels(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
}

/** Position + normal (+ optional colour), non-indexed, in the given matrix. */
function bakeGeometry(geo, matrix) {
  const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

function stripTo(g, names) {
  for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  return g;
}

/** Collect meshes with their transforms relative to the glTF scene root. */
function meshesOf(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out = [];
  root.traverse((o) => {
    if (o.isMesh) out.push({ mesh: o, matrix: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
  });
  return out;
}

// --------------------------------------------------------------------- cars
const PALETTE_COLS = 16;
const PALETTE_ROWS = 4;
const isGlassCell = (c, r) => (r === 0 && c <= 1) || (r === 3 && c <= 1);
const isChromeCell = (c, r) => r === 2 && (c === 10 || c === 11);
const isWhiteCell = (c, r) => r === 2 && (c === 12 || c === 13);
const isRedLampCell = (c, r) => r === 3 && (c === 4 || c === 5);
const isAmberCell = (c, r) => r === 3 && (c === 2 || c === 3);
const isNeutralCell = (c, r) => (r === 2 && c >= 2 && c <= 9) || (r === 0 && c >= 6);

/**
 * Split a Kenney car into the vehicle-shape parts. Triangles are classified
 * by the palette cell (16x4 grid) their UV centroid falls in.
 */
function convertCar(gltf, def) {
  const root = gltf.scene;
  const parts = meshesOf(root);
  const wheelNodes = parts.filter((p) => /^wheel-(front|back)-(left|right)$/.test(p.mesh.name));
  const bodyParts = parts.filter((p) => !wheelNodes.includes(p));
  const map = bodyParts[0].mesh.material.map;
  const px = imagePixels(map.image);
  const off = map.offset;
  const rep = map.repeat;

  // Gather triangles with their cell, colour and geometry.
  const tris = [];
  const box = new THREE.Box3();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const { mesh, matrix } of bodyParts) {
    const g = bakeGeometry(mesh.geometry, matrix);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i += 3) {
      let u = 0;
      let w = 0;
      for (let k = 0; k < 3; k++) {
        v[k].fromBufferAttribute(pos, i + k);
        box.expandByPoint(v[k]);
        u += uv.getX(i + k) / 3;
        w += uv.getY(i + k) / 3;
      }
      u = u * rep.x + off.x;
      w = w * rep.y + off.y;
      const col = Math.min(Math.floor(u * PALETTE_COLS), PALETTE_COLS - 1);
      const row = Math.min(Math.floor(w * PALETTE_ROWS), PALETTE_ROWS - 1);
      // Image row 0 is the top of the texture (glTF UVs have v pointing down).
      const ix = Math.min(Math.floor(u * px.w), px.w - 1);
      const iy = Math.min(Math.floor(w * px.h), px.h - 1);
      const p = (iy * px.w + ix) * 4;
      const color = new THREE.Color(px.data[p] / 255, px.data[p + 1] / 255, px.data[p + 2] / 255).convertSRGBToLinear();
      const n = new THREE.Vector3().fromBufferAttribute(nor, i);
      tris.push({ pts: v.map((x) => x.clone()), n, col, row, color, area: new THREE.Triangle(v[0], v[1], v[2]).getArea() });
    }
  }

  // Paint = the biggest coloured (non-neutral, non-glass, non-chrome) cell.
  const areas = new Map();
  for (const t of tris) {
    const key = `${t.col},${t.row}`;
    if (isGlassCell(t.col, t.row) || isChromeCell(t.col, t.row) || isNeutralCell(t.col, t.row)) continue;
    areas.set(key, (areas.get(key) || 0) + t.area);
  }
  let paintKey = null;
  let best = 0;
  for (const [k, a] of areas) if (a > best) { best = a; paintKey = k; }
  // Neighbouring cell of the same colour pair (cells come in gradient pairs).
  const [pc, pr] = paintKey.split(',').map(Number);
  const pairCol = pc % 2 === 0 ? pc + 1 : pc - 1;
  const isPaint = (t) => t.row === pr && (t.col === pc || t.col === pairCol);

  // Scale to real-world size; floor at y = 0.
  const [L, W, H] = def.size;
  const size = box.getSize(new THREE.Vector3());
  const scale = new THREE.Vector3(W / size.x, H / size.y, L / size.z);
  const center = box.getCenter(new THREE.Vector3());
  const toWorld = (p) => new THREE.Vector3((p.x - center.x) * scale.x, (p.y - box.min.y) * scale.y, (p.z - center.z) * scale.z);

  const groups = { paint: [], glass: [], chrome: [], trim: [] };
  const lampTris = { head: [], tail: [], ind: [] };
  const halfL = size.z / 2;
  for (const t of tris) {
    let cls;
    const front = t.n.z > 0.5 && t.pts[0].z - center.z > halfL * 0.55;
    const back = t.n.z < -0.5 && t.pts[0].z - center.z < -halfL * 0.55;
    if (isPaint(t)) cls = 'paint';
    else if (isGlassCell(t.col, t.row)) cls = 'glass';
    else if (isWhiteCell(t.col, t.row) && front) { cls = 'trim'; lampTris.head.push(t); }
    else if (isRedLampCell(t.col, t.row) && back) { cls = 'trim'; lampTris.tail.push(t); }
    else if (isAmberCell(t.col, t.row) && (front || back)) { cls = 'trim'; lampTris.ind.push(t); }
    else if (isChromeCell(t.col, t.row) || isWhiteCell(t.col, t.row)) cls = 'chrome';
    else cls = 'trim';
    groups[cls].push(t);
  }

  const build = (list, withColor) => {
    if (!list.length) return null;
    const pos = new Float32Array(list.length * 9);
    const col = withColor ? new Float32Array(list.length * 9) : null;
    list.forEach((t, i) => {
      t.pts.forEach((p, k) => {
        const q = toWorld(p);
        pos.set([q.x, q.y, q.z], i * 9 + k * 3);
        if (col) col.set([t.color.r, t.color.g, t.color.b], i * 9 + k * 3);
      });
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  };

  // Lamps: bounding box of each cluster of lamp triangles (split left / right).
  const lampSpecs = (list, inset = 0) => {
    const out = [];
    for (const side of [1, -1]) {
      const sideList = list.filter((t) => Math.sign(t.pts[0].x - center.x || 1) === side);
      if (!sideList.length) continue;
      const b = new THREE.Box3();
      for (const t of sideList) for (const p of t.pts) b.expandByPoint(toWorld(p));
      const c = b.getCenter(new THREE.Vector3());
      const s = b.getSize(new THREE.Vector3());
      const zOut = Math.sign(c.z) * 0.02;
      out.push([c.x * (1 - inset), c.y, c.z + zOut, Math.max(s.x, 0.08), Math.max(s.y, 0.06)]);
    }
    return out;
  };

  const fb = getVehicleShape(def.fallback);
  const head = lampSpecs(lampTris.head);
  const tail = lampSpecs(lampTris.tail);
  const indAll = lampSpecs(lampTris.ind.filter((t) => t.pts[0].z > center.z));
  const indRearAll = lampSpecs(lampTris.ind.filter((t) => t.pts[0].z < center.z));
  const pair = (list, fallback) => (list.length === 2 ? list : fallback);

  // Wheels: from the wheel nodes, scaled, kept round.
  const avg = (scale.x + scale.y + scale.z) / 3;
  const wheels = wheelNodes.map(({ mesh, matrix }) => {
    const wb = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position')).applyMatrix4(matrix);
    const c = toWorld(wb.getCenter(new THREE.Vector3()));
    return [c.x, c.z, c.z > 0];
  });
  const kenneyWheelR = 0.3;
  const wheelRadius = kenneyWheelR * avg * 0.9;

  const shape = {
    model: true,
    length: L, width: W, height: H,
    wheelRadius,
    wheelWidth: 0.35 * scale.x * 0.85,
    wheels,
    paint: build(groups.paint, false),
    glass: build(groups.glass, false),
    chrome: build(groups.chrome, false),
    trim: build(groups.trim, true),
    head: pair(head, fb.lamps.head),
    tail: pair(tail, fb.lamps.tail),
    indFront: pair(indAll, fb.lamps.indFront),
    indRear: pair(indRearAll, fb.lamps.indRear),
    reverse: (tail.length === 2 ? tail : fb.lamps.tail).map(([x, y, z, w, h]) => [x * 0.55, y - Math.max(h * 0.4, 0.05), z, w * 0.5, 0.06]),
    // Cockpit view uses the matching procedural interior (hood slice,
    // pillars, roof, dashboard): seen from inside, the model's own back faces
    // would just be an unlit shell.
    cockpit: fb.cockpit,
    lod: def.fallback,
  };
  return shape;
}

/** Kenney wheel -> unit tyre / rim geometries (radius 1, width 1, axle along X). */
function convertWheel(gltf) {
  const parts = meshesOf(gltf.scene);
  const { mesh, matrix } = parts[0];
  const g = bakeGeometry(mesh.geometry, matrix);
  const map = mesh.material.map;
  const px = imagePixels(map.image);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const tyre = [];
  const rim = [];
  for (let i = 0; i < pos.count; i += 3) {
    let u = 0;
    let w = 0;
    for (let k = 0; k < 3; k++) {
      u += uv.getX(i + k) / 3;
      w += uv.getY(i + k) / 3;
    }
    u = u * map.repeat.x + map.offset.x;
    w = w * map.repeat.y + map.offset.y;
    const p = (Math.min(Math.floor(w * px.h), px.h - 1) * px.w + Math.min(Math.floor(u * px.w), px.w - 1)) * 4;
    const lum = (px.data[p] + px.data[p + 1] + px.data[p + 2]) / 765;
    const pts = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, i + k)
      .sub(c).multiply(new THREE.Vector3(1 / s.x, 2 / s.y, 2 / s.z)));
    (lum < 0.3 ? tyre : rim).push(...pts);
  }
  const make = (pts) => {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    geo.computeVertexNormals();
    return geo;
  };
  return { tyre: make(tyre), rim: make(rim) };
}

// --------------------------------------------------------------- characters
/**
 * Rigid-node character -> one SkinnedMesh: every part becomes a bone with
 * the node's name (so the glTF animation clips bind unchanged) and its
 * vertices are weighted 100% to that bone.
 */
function convertCharacter(gltf, id) {
  const top = gltf.scene.children[0] ?? gltf.scene;
  top.updateMatrixWorld(true);
  const bones = [];
  const boneOf = new Map();
  const makeBone = (node, parent) => {
    const b = new THREE.Bone();
    b.name = node.name;
    b.position.copy(node.position);
    b.quaternion.copy(node.quaternion);
    b.scale.copy(node.scale);
    parent?.add(b);
    bones.push(b);
    boneOf.set(node, bones.length - 1);
    for (const c of node.children) makeBone(c, b);
    return b;
  };
  const rootNode = top.children.find((c) => c.name === 'root') ?? top;
  const rootBone = makeBone(rootNode, null);

  const inv = new THREE.Matrix4().copy(top.matrixWorld).invert();
  const geos = [];
  let material = null;
  rootNode.traverse((o) => {
    if (!o.isMesh) return;
    material ??= o.material;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const g = stripTo(bakeGeometry(o.geometry, m), ['position', 'normal', 'uv']);
    const n = g.getAttribute('position').count;
    const idx = boneOf.get(o);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, k) => (k % 4 === 0 ? idx : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, k) => (k % 4 === 0 ? 1 : 0)), 4));
    geos.push(g);
  });
  const geo = mergeGeometries(geos);
  // Normalise height to ~1.75 m with feet at y = 0.
  geo.computeBoundingBox();
  const h = geo.boundingBox.max.y - geo.boundingBox.min.y;
  const k = 1.75 / h;

  // Lit (not unlit) material so the characters sit in the scene's lighting;
  // the palette texture is downsampled (blocky art doesn't need 1024 px).
  const tex = downsample(material.map, 128);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  const holder = new THREE.Group();
  holder.add(mesh);
  mesh.add(rootBone);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  holder.userData.baseScale = k;
  holder.userData.baseY = -geo.boundingBox.min.y * k;

  const clips = {};
  for (const c of gltf.animations) clips[c.name] = c;
  return { id, template: holder, clips };
}

function downsample(tex, size) {
  if (!tex?.image) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tex.image, 0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = tex.flipY;
  t.magFilter = THREE.NearestFilter;
  return t;
}

// ------------------------------------------------------------ static props
/**
 * Merge a static model into one geometry with vertex colours (material
 * colour, or the texture colour at each triangle for palette-textured
 * models), so it can be instanced with a single vertex-coloured material.
 */
function bakeStatic(gltf) {
  const geos = [];
  for (const { mesh, matrix } of meshesOf(gltf.scene)) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const g0 = mesh.geometry;
    const groups = g0.groups.length ? g0.groups : [{ start: 0, count: g0.index ? g0.index.count : g0.getAttribute('position').count, materialIndex: 0 }];
    const full = bakeGeometry(g0, matrix);
    const pos = full.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (const grp of groups) {
      const mat = mats[grp.materialIndex] ?? mats[0];
      const base = mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1);
      let px = null;
      if (mat.map?.image) px = imagePixels(mat.map.image);
      const uv = full.getAttribute('uv');
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        let c = base;
        if (px && uv) {
          const u = uv.getX(i) * mat.map.repeat.x + mat.map.offset.x;
          const w = uv.getY(i) * mat.map.repeat.y + mat.map.offset.y;
          const p = (Math.min(Math.max(Math.floor(w * px.h), 0), px.h - 1) * px.w + Math.min(Math.max(Math.floor(u * px.w), 0), px.w - 1)) * 4;
          c = new THREE.Color(px.data[p] / 255, px.data[p + 1] / 255, px.data[p + 2] / 255).convertSRGBToLinear().multiply(base);
        }
        col.set([c.r, c.g, c.b], i * 3);
      }
    }
    full.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(stripTo(full, ['position', 'normal', 'color']));
  }
  const g = mergeGeometries(geos);
  g.computeBoundingBox();
  return g;
}

