import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural vehicle shapes shared by the player car and AI traffic.
 *
 * Each shape is built from extruded side profiles plus a few boxes and is
 * split by material: `paint` (body colour), `secondary` (a second, light
 * colour: truck cargo box, taxi sign; may be null), `glass` and `trim`
 * (bumpers, skirts, rider...). Geometry is non-indexed with position + normal
 * only, so every part can live in the same BatchedMesh.
 *
 * Car local axes: +Z forward, +Y up, +X = driver's left.
 * Lamps are [x, y, z, width, height]. Indicator lists are [left, right] pairs.
 */
const cache = new Map();

/** Strip to position + normal, non-indexed. */
function clean(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  return g;
}

/** Extrude a side profile (points as [forward, up]) across the car's width. */
export function extrudeProfile(points, width, bevel) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // Shape X -> world +Z (forward), extrusion Z -> world -X; then centre on X.
  geo.rotateY(-Math.PI / 2);
  geo.translate((width - bevel * 2) / 2, 0, 0);
  geo.computeVertexNormals();
  return clean(geo);
}

const box = (w, h, d, x = 0, y = 0, z = 0, rotX = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX) g.rotateX(rotX);
  return clean(g.translate(x, y, z));
};
const merge = (list) => mergeGeometries(list.filter(Boolean));
/** Mirror lamp specs across the car's centre line: [left, right]. */
const pair = (x, y, z, w, h) => [[x, y, z, w, h], [-x, y, z, w, h]];

// ---------------------------------------------------------------- definitions
const DEFS = {
  sedan: () => ({
    length: 4.4, width: 1.88, height: 1.4,
    wheelRadius: 0.34, wheelWidth: 0.26,
    wheels: [[0.8, 1.32, true], [-0.8, 1.32, true], [0.8, -1.3, false], [-0.8, -1.3, false]],
    paint: [
      extrudeProfile([[-2.12, 0.32], [2.1, 0.32], [2.18, 0.58], [2.05, 0.8], [0.9, 0.93], [-1.75, 0.98], [-2.14, 0.9], [-2.18, 0.42]], 1.84, 0.06),
      box(1.5, 0.05, 1.18, 0, 1.37, -0.44),
    ],
    glass: [extrudeProfile([[0.95, 0.9], [0.18, 1.34], [-1.05, 1.34], [-1.82, 0.95]], 1.62, 0.04)],
    trim: [
      box(1.7, 0.18, 0.12, 0, 0.4, 2.16),
      box(1.7, 0.18, 0.12, 0, 0.42, -2.18),
      box(1.88, 0.1, 2.4, 0, 0.33, 0),
    ],
    head: pair(0.6, 0.66, 2.2, 0.42, 0.12),
    tail: pair(0.62, 0.74, -2.23, 0.4, 0.12),
    indFront: pair(0.84, 0.58, 2.19, 0.14, 0.08),
    indRear: pair(0.8, 0.6, -2.2, 0.2, 0.08),
    reverse: pair(0.32, 0.74, -2.22, 0.16, 0.1),
    cockpit: {
      eye: [0.36, 1.18, -0.2],
      hood: [[0.92, 0.6], [2.1, 0.6], [2.18, 0.62], [2.05, 0.8], [0.92, 0.93]], hoodWidth: 1.84,
      dash: [0.88, 0.7], wheel: [1.0, 0.36], roof: [1.335, -0.42, 1.28, 1.56],
      pillarBase: [0.8, 0.95, 0.92], pillarTop: [0.72, 1.35, 0.16], door: [0.88, 0.75],
    },
  }),

  hatchback: () => ({
    length: 3.96, width: 1.8, height: 1.42,
    wheelRadius: 0.31, wheelWidth: 0.24,
    wheels: [[0.76, 1.2, true], [-0.76, 1.2, true], [0.76, -1.22, false], [-0.76, -1.22, false]],
    paint: [
      extrudeProfile([[-1.92, 0.3], [1.9, 0.3], [1.97, 0.55], [1.86, 0.76], [0.8, 0.9], [-1.7, 0.96], [-1.93, 0.86], [-1.96, 0.4]], 1.76, 0.06),
      box(1.44, 0.05, 1.5, 0, 1.385, -0.69),
    ],
    glass: [extrudeProfile([[0.86, 0.88], [0.12, 1.36], [-1.5, 1.36], [-1.8, 0.92]], 1.56, 0.04)],
    trim: [
      box(1.62, 0.18, 0.12, 0, 0.38, 1.96),
      box(1.62, 0.18, 0.12, 0, 0.4, -1.97),
      box(1.8, 0.1, 2.2, 0, 0.31, 0),
    ],
    head: pair(0.56, 0.64, 1.95, 0.38, 0.13),
    tail: pair(0.64, 0.8, -1.965, 0.28, 0.2),
    indFront: pair(0.8, 0.56, 1.96, 0.14, 0.07),
    indRear: pair(0.64, 0.64, -1.965, 0.28, 0.07),
    reverse: pair(0.3, 0.62, -1.965, 0.16, 0.08),
    cockpit: {
      eye: [0.34, 1.16, -0.25],
      hood: [[0.84, 0.6], [1.9, 0.6], [1.97, 0.62], [1.86, 0.76], [0.84, 0.89]], hoodWidth: 1.76,
      dash: [0.86, 0.62], wheel: [0.98, 0.3], roof: [1.36, -0.69, 1.4, 1.48],
      pillarBase: [0.76, 0.92, 0.86], pillarTop: [0.68, 1.33, 0.14], door: [0.84, 0.74],
    },
  }),

  sports: () => ({
    length: 4.5, width: 2.0, height: 1.18,
    wheelRadius: 0.34, wheelWidth: 0.3,
    wheels: [[0.86, 1.35, true], [-0.86, 1.35, true], [0.86, -1.32, false], [-0.86, -1.32, false]],
    paint: [
      extrudeProfile([[-2.2, 0.26], [2.15, 0.26], [2.26, 0.42], [2.12, 0.6], [0.7, 0.8], [-1.55, 0.86], [-2.2, 0.8], [-2.24, 0.36]], 1.96, 0.07),
      box(1.46, 0.04, 0.86, 0, 1.16, -0.5),
    ],
    glass: [extrudeProfile([[0.76, 0.78], [-0.05, 1.14], [-0.95, 1.14], [-1.85, 0.84]], 1.58, 0.04)],
    trim: [
      box(1.9, 0.06, 0.3, 0, 0.24, 2.05),
      box(1.7, 0.14, 0.12, 0, 0.3, -2.22),
      box(1.98, 0.08, 2.3, 0, 0.28, 0),
      box(1.78, 0.05, 0.34, 0, 1.02, -2.0),
      box(0.06, 0.18, 0.12, 0.55, 0.92, -1.98),
      box(0.06, 0.18, 0.12, -0.55, 0.92, -1.98),
    ],
    head: pair(0.66, 0.5, 2.23, 0.46, 0.08),
    tail: pair(0.6, 0.68, -2.235, 0.5, 0.08),
    indFront: pair(0.88, 0.44, 2.2, 0.12, 0.06),
    indRear: pair(0.9, 0.68, -2.225, 0.1, 0.08),
    reverse: pair(0.25, 0.68, -2.235, 0.12, 0.08),
    cockpit: {
      eye: [0.36, 0.98, -0.35],
      hood: [[0.72, 0.5], [2.12, 0.5], [2.2, 0.52], [2.12, 0.6], [0.72, 0.79]], hoodWidth: 1.96,
      dash: [0.7, 0.45], wheel: [0.84, 0.2], roof: [1.13, -0.5, 0.9, 1.5],
      pillarBase: [0.8, 0.8, 0.74], pillarTop: [0.7, 1.12, -0.04], door: [0.9, 0.62],
    },
  }),

  suv: () => ({
    length: 4.8, width: 2.02, height: 1.88,
    wheelRadius: 0.42, wheelWidth: 0.3,
    wheels: [[0.86, 1.45, true], [-0.86, 1.45, true], [0.86, -1.42, false], [-0.86, -1.42, false]],
    paint: [
      extrudeProfile([[-2.3, 0.45], [2.25, 0.45], [2.36, 0.75], [2.26, 1.05], [1.1, 1.16], [-2.25, 1.2], [-2.36, 1.06], [-2.37, 0.55]], 1.98, 0.06),
      box(1.68, 0.05, 2.4, 0, 1.785, -0.83),
    ],
    glass: [extrudeProfile([[1.15, 1.12], [0.42, 1.76], [-2.08, 1.76], [-2.26, 1.18]], 1.8, 0.04)],
    trim: [
      box(1.9, 0.28, 0.16, 0, 0.55, 2.32),
      box(1.9, 0.28, 0.16, 0, 0.55, -2.34),
      box(2.0, 0.22, 2.6, 0, 0.52, 0),
      box(0.06, 0.06, 2.2, 0.7, 1.84, -0.85),
      box(0.06, 0.06, 2.2, -0.7, 1.84, -0.85),
      box(1.5, 0.04, 0.06, 0, 1.86, -0.2),
      box(1.5, 0.04, 0.06, 0, 1.86, -1.5),
    ],
    head: pair(0.68, 0.98, 2.31, 0.4, 0.14),
    tail: pair(0.82, 1.0, -2.39, 0.16, 0.34),
    indFront: pair(0.88, 0.86, 2.35, 0.12, 0.08),
    indRear: pair(0.82, 0.76, -2.39, 0.16, 0.08),
    reverse: pair(0.5, 0.55, -2.43, 0.16, 0.08),
    cockpit: {
      eye: [0.38, 1.55, -0.1],
      hood: [[1.12, 0.9], [2.26, 0.9], [2.34, 0.92], [2.26, 1.05], [1.12, 1.16]], hoodWidth: 1.98,
      dash: [1.12, 0.9], wheel: [1.3, 0.62], roof: [1.75, -0.83, 2.3, 1.72],
      pillarBase: [0.86, 1.14, 1.12], pillarTop: [0.8, 1.74, 0.44], door: [0.94, 1.0],
    },
  }),

  pickup: () => ({
    length: 5.4, width: 2.04, height: 1.88,
    wheelRadius: 0.42, wheelWidth: 0.32,
    wheels: [[0.88, 1.75, true], [-0.88, 1.75, true], [0.88, -1.45, false], [-0.88, -1.45, false]],
    paint: [
      extrudeProfile([[-2.65, 0.48], [2.6, 0.48], [2.68, 0.8], [2.56, 1.12], [1.35, 1.2], [-2.66, 1.2], [-2.67, 0.56]], 2.0, 0.06),
      extrudeProfile([[1.32, 1.18], [0.72, 1.86], [-0.66, 1.86], [-0.72, 1.18]], 1.86, 0.03),
      box(0.08, 0.3, 1.95, 0.94, 1.35, -1.68),
      box(0.08, 0.3, 1.95, -0.94, 1.35, -1.68),
      box(1.88, 0.3, 0.08, 0, 1.35, -2.62),
    ],
    // Window band slightly proud of the cab so it shows on every side.
    glass: [extrudeProfile([[1.26, 1.3], [0.8, 1.82], [-0.62, 1.82], [-0.75, 1.3]], 1.9, 0)],
    trim: [
      box(1.78, 0.02, 1.9, 0, 1.215, -1.68),
      box(2.0, 0.22, 0.16, 0, 0.6, 2.62),
      box(2.0, 0.22, 0.16, 0, 0.6, -2.66),
      box(2.02, 0.14, 3.2, 0, 0.52, -0.1),
      box(1.2, 0.28, 0.04, 0, 0.95, 2.64),
    ],
    head: pair(0.8, 1.0, 2.63, 0.3, 0.16),
    tail: pair(0.94, 1.25, -2.68, 0.12, 0.3),
    indFront: pair(0.92, 0.82, 2.66, 0.12, 0.08),
    indRear: pair(0.94, 1.06, -2.68, 0.12, 0.08),
    reverse: pair(0.6, 0.6, -2.75, 0.14, 0.07),
    cockpit: {
      eye: [0.4, 1.6, 0.05],
      hood: [[1.3, 0.95], [2.56, 0.95], [2.64, 0.97], [2.56, 1.12], [1.3, 1.2]], hoodWidth: 2.0,
      dash: [1.22, 1.0], wheel: [1.35, 0.68], roof: [1.84, 0.03, 1.3, 1.8],
      pillarBase: [0.86, 1.2, 1.3], pillarTop: [0.82, 1.84, 0.74], door: [0.95, 1.05],
    },
  }),

  tuktuk: () => ({
    length: 2.7, width: 1.4, height: 2.02,
    wheelRadius: 0.25, wheelWidth: 0.16,
    wheels: [[0, 0.95, true], [0.6, -0.75, false], [-0.6, -0.75, false]],
    paint: [
      extrudeProfile([[-1.3, 0.42], [1.12, 0.42], [1.3, 0.55], [1.3, 1.25], [1.14, 1.27], [0.95, 0.64], [-1.3, 0.64]], 1.26, 0.05),
      box(1.26, 0.9, 0.08, 0, 1.05, -1.26),
      box(1.4, 0.08, 2.45, 0, 1.98, -0.08),
    ],
    glass: [box(1.1, 0.66, 0.03, 0, 1.6, 1.16)],
    trim: [
      box(0.05, 0.7, 0.05, 0.6, 1.62, 1.16),
      box(0.05, 0.7, 0.05, -0.6, 1.62, 1.16),
      box(0.05, 1.32, 0.05, 0.63, 1.3, -1.22),
      box(0.05, 1.32, 0.05, -0.63, 1.3, -1.22),
      box(1.1, 0.22, 0.5, 0, 0.78, -0.75),
      box(1.1, 0.5, 0.1, 0, 1.0, -1.0),
      box(0.5, 0.15, 0.4, 0, 0.78, 0.25),
      box(0.7, 0.04, 0.04, 0, 1.2, 0.8),
      box(0.22, 0.08, 0.5, 0, 0.58, 0.95),
    ],
    head: [[0, 1.0, 1.33, 0.22, 0.16]],
    tail: pair(0.5, 0.82, -1.32, 0.14, 0.12),
    indFront: pair(0.5, 1.15, 1.33, 0.1, 0.07),
    indRear: pair(0.5, 1.0, -1.32, 0.1, 0.07),
    reverse: [[0, 0.82, -1.32, 0.12, 0.08]],
    cockpit: {
      eye: [0, 1.52, 0.1],
      hood: [[0.95, 0.64], [1.3, 0.64], [1.3, 1.25], [1.14, 1.27]], hoodWidth: 1.26,
      dash: [0.9, 1.0], wheel: [1.22, 0.8], roof: [1.94, -0.08, 2.4, 1.36],
      pillarBase: [0.6, 1.27, 1.16], pillarTop: [0.6, 1.95, 1.16], door: null,
    },
  }),

  // ------------------------------------------------------------- AI only
  taxi: () => {
    const s = DEFS.sedan();
    s.secondary = [box(0.7, 0.18, 0.3, 0, 1.48, -0.45)];
    return s;
  },

  bus: () => ({
    length: 11.1, width: 2.56, height: 3.3,
    wheelRadius: 0.5, wheelWidth: 0.35,
    wheels: [[1.08, 3.9, true], [-1.08, 3.9, true], [1.08, -3.0, false], [-1.08, -3.0, false]],
    paint: [extrudeProfile([[-5.5, 0.4], [5.45, 0.4], [5.52, 0.6], [5.52, 2.95], [5.35, 3.15], [-5.4, 3.15], [-5.52, 3.0], [-5.52, 0.5]], 2.5, 0.05)],
    glass: [
      box(2.54, 1.0, 10.2, 0, 2.05, -0.15),
      box(2.3, 1.6, 0.04, 0, 1.95, 5.54),
      box(2.2, 0.8, 0.04, 0, 2.2, -5.54),
    ],
    trim: [
      box(2.5, 0.3, 0.15, 0, 0.55, 5.55),
      box(2.5, 0.3, 0.15, 0, 0.55, -5.55),
      box(2.52, 0.25, 10.6, 0, 0.5, 0),
      box(1.4, 0.25, 2.2, 0, 3.27, -1),
    ],
    head: pair(0.85, 0.85, 5.6, 0.36, 0.18),
    tail: pair(1.1, 0.9, -5.6, 0.16, 0.3),
    indFront: pair(1.15, 0.85, 5.6, 0.12, 0.1),
    indRear: pair(1.1, 1.18, -5.6, 0.16, 0.1),
    reverse: pair(0.7, 0.9, -5.6, 0.16, 0.1),
  }),

  truck: () => ({
    length: 7.6, width: 2.46, height: 3.4,
    wheelRadius: 0.48, wheelWidth: 0.35,
    wheels: [[1.0, 2.85, true], [-1.0, 2.85, true], [1.0, -2.4, false], [-1.0, -2.4, false]],
    paint: [extrudeProfile([[1.9, 0.5], [3.7, 0.5], [3.78, 0.7], [3.76, 2.55], [3.45, 2.8], [1.9, 2.8]], 2.3, 0.05)],
    secondary: [box(2.44, 2.5, 5.6, 0, 2.15, -0.95)],
    glass: [box(2.0, 0.85, 0.04, 0, 2.05, 3.8), box(2.34, 0.7, 1.2, 0, 2.1, 2.95)],
    trim: [
      box(1.2, 0.3, 7.3, 0, 0.65, -0.05),
      box(2.3, 0.3, 0.15, 0, 0.6, 3.8),
      box(2.2, 0.2, 0.12, 0, 0.75, -3.78),
      box(1.4, 0.5, 0.04, 0, 1.1, 3.8),
    ],
    head: pair(0.9, 0.95, 3.82, 0.3, 0.18),
    tail: pair(1.05, 1.0, -3.8, 0.18, 0.22),
    indFront: pair(1.1, 1.25, 3.8, 0.1, 0.1),
    indRear: pair(1.05, 1.25, -3.8, 0.12, 0.1),
    reverse: pair(0.75, 1.0, -3.8, 0.12, 0.1),
  }),

  motorbike: () => ({
    length: 2.1, width: 0.8, height: 1.95,
    wheelRadius: 0.3, wheelWidth: 0.12,
    wheels: [[0, 0.75, true], [0, -0.7, false]],
    paint: [
      box(0.32, 0.22, 0.55, 0, 0.95, 0.25),
      box(0.36, 0.4, 0.25, 0, 1.0, 0.7),
      box(0.26, 0.15, 0.5, 0, 0.95, -0.55),
      clean(new THREE.IcosahedronGeometry(0.16, 1).translate(0, 1.86, -0.1)),
    ],
    glass: [box(0.3, 0.2, 0.02, 0, 1.28, 0.8)],
    trim: [
      box(0.16, 0.28, 1.2, 0, 0.6, 0),
      box(0.3, 0.1, 0.6, 0, 1.02, -0.25),
      box(0.06, 0.6, 0.06, 0.08, 0.65, 0.78),
      box(0.06, 0.6, 0.06, -0.08, 0.65, 0.78),
      box(0.7, 0.04, 0.04, 0, 1.22, 0.62),
      box(0.42, 0.6, 0.26, 0, 1.4, -0.15, 0.35),   // rider torso, leaning forward
      box(0.38, 0.18, 0.55, 0, 1.08, -0.05),       // thighs
      box(0.5, 0.09, 0.45, 0, 1.38, 0.25, -0.5),   // arms to the bars
    ],
    head: [[0, 1.02, 0.84, 0.14, 0.12]],
    tail: [[0, 1.0, -0.82, 0.12, 0.06]],
    indFront: pair(0.2, 1.0, 0.8, 0.05, 0.05),
    indRear: pair(0.15, 0.95, -0.82, 0.05, 0.05),
    reverse: [],
  }),
};

export const VEHICLE_TYPES = Object.keys(DEFS);

/** Collision circles spanning a vehicle footprint: [{forward, radius}]. */
export function circlesFor(length, width) {
  const r = (width / 2) * 0.98;
  const span = Math.max(length / 2 - r, 0);
  const n = Math.max(2, Math.ceil((span * 2) / (r * 1.3)) + 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ forward: span - (span * 2 * i) / (n - 1), radius: r });
  return out;
}

/** Built, cached shape for a vehicle type. */
export function getVehicleShape(type) {
  let s = cache.get(type);
  if (s) return s;
  const def = (DEFS[type] || DEFS.sedan)();
  s = {
    type,
    length: def.length,
    width: def.width,
    height: def.height,
    wheelRadius: def.wheelRadius,
    wheelWidth: def.wheelWidth,
    wheels: def.wheels,
    geo: {
      paint: merge(def.paint),
      secondary: def.secondary ? merge(def.secondary) : null,
      glass: merge(def.glass),
      trim: merge(def.trim),
    },
    lamps: {
      head: def.head, tail: def.tail, indFront: def.indFront, indRear: def.indRear, reverse: def.reverse,
    },
    cockpit: def.cockpit || null,
    circles: circlesFor(def.length, def.width),
  };
  cache.set(type, s);
  return s;
}

/** Shared unit geometries for wheels and lamps (scaled per instance). */
let unit = null;
export function getUnitGeometries() {
  if (unit) return unit;
  unit = {
    wheel: clean(new THREE.CylinderGeometry(1, 1, 1, 12).rotateZ(Math.PI / 2)),
    rim: clean(new THREE.CylinderGeometry(0.6, 0.6, 1.08, 8).rotateZ(Math.PI / 2)),
    lamp: clean(new THREE.BoxGeometry(1, 1, 0.06)),
  };
  return unit;
}
