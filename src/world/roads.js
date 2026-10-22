import * as THREE from 'three';
import { createRng } from '../core/utils.js';
import { textureSet } from '../core/assets.js';
import { getNoiseTexture } from './noise.js';

/**
 * Ground, asphalt, sidewalks (rounded corners, bevelled kerbs), parks,
 * worn lane markings, crosswalks, stop lines, manholes, cracks and the
 * boundary wall. Repeated pieces are InstancedMesh, so the road network is a
 * handful of draw calls.
 *
 * Asphalt shading (see patchAsphalt): PBR texture + large-scale tonal
 * variation, darker polished tyre tracks in each lane, and puddles that
 * appear with wetness (uWet, driven by the weather).
 */
export const roadUniforms = {
  uWet: { value: 0 },
  uNoise: { value: null },
};

export function buildRoads(layout) {
  const group = new THREE.Group();
  group.name = 'roads';
  const cfg = layout.cfg;
  const rw = cfg.roadWidth;
  roadUniforms.uNoise.value = getNoiseTexture();

  // --- Ground (grass outside the city) -------------------------------------
  // A square ring around the city (no grass drawn under the asphalt).
  const groundSize = layout.extentX + 900;
  const grass = textureSet('grass', 1 / 9);
  const outer = groundSize / 2;
  const ring = new THREE.Shape([
    new THREE.Vector2(-outer, -outer), new THREE.Vector2(outer, -outer),
    new THREE.Vector2(outer, outer), new THREE.Vector2(-outer, outer),
  ]);
  const hx = layout.halfX + 1;
  const hz = layout.halfZ + 1;
  ring.holes.push(new THREE.Path([
    new THREE.Vector2(-hx, -hz), new THREE.Vector2(-hx, hz), new THREE.Vector2(hx, hz), new THREE.Vector2(hx, -hz),
  ]));
  const ground = new THREE.Mesh(
    new THREE.ShapeGeometry(ring),
    new THREE.MeshStandardMaterial({
      color: grass.color ? 0xb8c4a0 : 0x6d8f4e, map: grass.color ?? null, normalMap: grass.normal ?? null, roughness: 1,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  // Big flat surfaces draw after everything that covers them, so the GPU's
  // early depth test skips their hidden pixels instead of shading them.
  ground.renderOrder = 11;
  group.add(ground);

  // --- Asphalt covering the entire grid -----------------------------------
  const asphaltTex = textureSet('asphalt', (layout.extentX + 3) / 7);
  const asphaltMat = new THREE.MeshStandardMaterial({
    color: asphaltTex.color ? 0x9a9ca2 : 0x3b3d42,
    map: asphaltTex.color ?? null,
    normalMap: asphaltTex.normal ?? null,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughnessMap: asphaltTex.rough ?? null,
    roughness: 0.95,
  });
  patchAsphalt(asphaltMat, layout);
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(layout.extentX + 3, layout.extentZ + 3), asphaltMat);
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.receiveShadow = true;
  asphalt.renderOrder = 10;
  group.add(asphalt);

  // --- Sidewalk slabs: rounded corners, bevelled kerb ----------------------
  const h = cfg.sidewalkHeight;
  const half = cfg.blockSize / 2;
  const corner = 2.5;
  const shape = roundedRect(half, corner);
  const bevel = 0.06;
  const slabGeo = new THREE.ExtrudeGeometry(shape, {
    depth: h - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  // Shape XY -> world XZ, extrusion up; with the bevel the slab spans y 0..h
  // (plazas and lawns sit just above it).
  slabGeo.rotateX(-Math.PI / 2);
  slabGeo.translate(0, bevel, 0);
  const paving = textureSet('sidewalk', 0.45);
  const concrete = textureSet('concrete', 0.5);
  const pavingMat = new THREE.MeshStandardMaterial({
    color: paving.color ? 0xffffff : 0xb9b6ae, map: paving.color ?? null, normalMap: paving.normal ?? null,
    roughnessMap: paving.rough ?? null, roughness: 0.9,
  });
  const curbMat = new THREE.MeshStandardMaterial({
    color: concrete.color ? 0xb0aea8 : 0x9f9c95, map: concrete.color ?? null, normalMap: concrete.normal ?? null, roughness: 0.85,
  });
  const sidewalks = new THREE.InstancedMesh(slabGeo, [pavingMat, curbMat], layout.blocks.length);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const parks = layout.blocks.filter((b) => b.park);
  const inner = cfg.blockSize - cfg.sidewalkWidth * 2;
  const lawnTex = textureSet('grass', inner / 7);
  const lawnMat = new THREE.MeshStandardMaterial({
    color: lawnTex.color ? 0xc8d8a8 : 0x5f9a45, map: lawnTex.color ?? null, normalMap: lawnTex.normal ?? null, roughness: 1,
  });
  const lawns = new THREE.InstancedMesh(unitBox, lawnMat, Math.max(parks.length, 1));
  const plazaTex = textureSet('sidewalk', inner / 2.2);
  const plazaMat = new THREE.MeshStandardMaterial({
    color: plazaTex.color ? 0xd8d2c8 : 0xa29d93, map: plazaTex.color ?? null, normalMap: plazaTex.normal ?? null, roughness: 0.92,
  });
  const plazas = new THREE.InstancedMesh(unitBox, plazaMat, layout.blocks.length);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let li = 0;
  let pi = 0;
  layout.blocks.forEach((b, i) => {
    sidewalks.setMatrixAt(i, m.compose(p.set(b.cx, 0, b.cz), q.identity(), s.set(1, 1, 1)));
    if (b.park) {
      lawns.setMatrixAt(li++, m.compose(p.set(b.cx, h + 0.02, b.cz), q, s.set(inner, 0.04, inner)));
    } else {
      plazas.setMatrixAt(pi++, m.compose(p.set(b.cx, h + 0.01, b.cz), q, s.set(inner, 0.02, inner)));
    }
  });
  lawns.count = li;
  plazas.count = pi;
  for (const mesh of [sidewalks, lawns, plazas]) {
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }
  sidewalks.renderOrder = 5;

  // --- Markings: flat quads with per-instance colour, worn ----------------
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const markings = [];
  const WHITE = new THREE.Color(0xe8e8e2);
  const YELLOW = new THREE.Color(0xe8b82e);
  const add = (x, z, sx, sz, color) => markings.push({ x, z, sx, sz, color });

  const dash = 3;
  const gap = 3.5;
  const crossLen = 3; // crosswalk depth along the road
  const segLen = cfg.blockSize;

  // Roads running along Z (constant x) and along X (constant z) share code.
  const addRoadSegments = (alongZ) => {
    const fixed = alongZ ? layout.roadX : layout.roadZ;
    const cross = alongZ ? layout.roadZ : layout.roadX;
    for (const c of fixed) {
      for (let j = 0; j < cross.length - 1; j++) {
        const start = cross[j] + rw / 2;
        const end = cross[j + 1] - rw / 2;
        const put = (along, lateral, lenAlong, lenLat, color) => {
          if (alongZ) add(c + lateral, along, lenLat, lenAlong, color);
          else add(along, c + lateral, lenAlong, lenLat, color);
        };
        // Centre dashes (between the crosswalks).
        const a0 = start + crossLen + 2;
        const a1 = end - crossLen - 2;
        for (let a = a0; a + dash <= a1; a += dash + gap) put(a + dash / 2, 0, dash, 0.18, YELLOW);
        // Solid edge lines.
        const edgeLen = segLen - 2 * (crossLen + 1);
        put((start + end) / 2, rw / 2 - 0.6, edgeLen, 0.14, WHITE);
        put((start + end) / 2, -(rw / 2 - 0.6), edgeLen, 0.14, WHITE);
        // Crosswalk zebra at both ends.
        for (const at of [start + crossLen / 2 + 0.3, end - crossLen / 2 - 0.3]) {
          for (let k = -rw / 2 + 1; k <= rw / 2 - 1; k += 1.1) put(at, k, crossLen, 0.55, WHITE);
        }
        // Stop lines: right-hand traffic. Traffic heading +axis uses the lane on
        // the side given by right(dir) = (-dz, dx), arriving at `end`.
        const lanePlus = alongZ ? -1 : 1; // lateral sign of the +direction lane
        put(end - crossLen - 1, lanePlus * rw / 4, 0.45, rw / 2 - 0.4, WHITE);
        put(start + crossLen + 1, -lanePlus * rw / 4, 0.45, rw / 2 - 0.4, WHITE);
      }
    }
  };
  addRoadSegments(true);
  addRoadSegments(false);

  const markMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.75,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  patchWorn(markMat);
  const markMesh = new THREE.InstancedMesh(quad, markMat, markings.length);
  markings.forEach((mk, i) => {
    markMesh.setMatrixAt(i, m.compose(p.set(mk.x, 0.015, mk.z), q.identity(), s.set(mk.sx, 1, mk.sz)));
    markMesh.setColorAt(i, mk.color);
  });
  markMesh.receiveShadow = true;
  markMesh.renderOrder = 12;
  markMesh.instanceMatrix.needsUpdate = true;
  group.add(markMesh);

  // --- Manhole covers and crack decals -------------------------------------
  group.add(buildDecals(layout, quad));

  // --- Boundary wall ------------------------------------------------------
  const wallMat = new THREE.MeshStandardMaterial({
    color: concrete.color ? 0xb8b6b0 : 0x9a9da3, map: concrete.color ?? null, roughness: 0.9,
  });
  const walls = new THREE.InstancedMesh(unitBox, wallMat, layout.borderWalls.length);
  layout.borderWalls.forEach((w, i) => {
    walls.setMatrixAt(i, m.compose(
      p.set((w.minX + w.maxX) / 2, 0.6, (w.minZ + w.maxZ) / 2), q,
      s.set(w.maxX - w.minX, 1.2, w.maxZ - w.minZ),
    ));
  });
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // Materials the weather system makes wet (the asphalt also gets puddles).
  group.userData.materials = { asphalt: asphaltMat, sidewalk: pavingMat, markings: markMat };
  return group;
}

/** Square of half-size `half` with rounded corners of radius r, centred on 0. */
function roundedRect(half, r) {
  const s = new THREE.Shape();
  s.moveTo(-half + r, -half);
  s.lineTo(half - r, -half);
  s.quadraticCurveTo(half, -half, half, -half + r);
  s.lineTo(half, half - r);
  s.quadraticCurveTo(half, half, half - r, half);
  s.lineTo(-half + r, half);
  s.quadraticCurveTo(-half, half, -half, half - r);
  s.lineTo(-half, -half + r);
  s.quadraticCurveTo(-half, -half, -half + r, -half);
  return s;
}

/** World position varying for patched standard materials. */
function addWorldPos(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vRoadPos;')
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      {
        vec4 rp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          rp = instanceMatrix * rp;
        #endif
        vRoadPos = (modelMatrix * rp).xyz;
      }`);
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    '#include <common>\nvarying vec3 vRoadPos;\nuniform sampler2D uNoise;\nuniform float uWet;',
  );
  shader.uniforms.uNoise = roadUniforms.uNoise;
  shader.uniforms.uWet = roadUniforms.uWet;
}

function patchAsphalt(material, layout) {
  const roadX0 = layout.roadX[0].toFixed(3);
  const cell = layout.cell.toFixed(3);
  const lane = layout.laneOffset.toFixed(3);
  material.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 nz = texture2D(uNoise, vRoadPos.xz * 0.0035);
        // Patchy repairs / sun-bleached areas.
        diffuseColor.rgb *= mix(0.78, 1.12, nz.r) * mix(0.92, 1.05, nz.g);
        // Tyre tracks: two per lane, darker and a little polished.
        float track = 0.0;
        {
          vec2 rel = mod(vRoadPos.xz - vec2(${roadX0}), vec2(${cell})) ;
          rel = min(rel, vec2(${cell}) - rel);              // distance to the nearest road centre line
          for (int k = 0; k < 2; k++) {
            float d = k == 0 ? rel.x : rel.y;
            float a = abs(abs(d - ${lane}) - 0.85);           // wheel paths of the lane on each side
            float b = abs(abs(d + ${lane}) - 0.85);
            track = max(track, 1.0 - smoothstep(0.2, 0.55, min(a, b)));
          }
          // Only on roads (not in the middle of junctions' far corners).
          track *= step(min(rel.x, rel.y), 7.0);
        }
        diffuseColor.rgb *= 1.0 - track * 0.12;
        // Puddles in hollows when wet.
        float puddle = smoothstep(0.56, 0.62, texture2D(uNoise, vRoadPos.xz * 0.018).g) * uWet;
        diffuseColor.rgb *= 1.0 - puddle * 0.6 - uWet * 0.18;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.8, track);
        roughnessFactor = mix(roughnessFactor, 0.45, uWet * 0.6);
        roughnessFactor = mix(roughnessFactor, 0.2, puddle);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(mix(normal, nonPerturbedNormal, puddle));`);
  };
  material.customProgramCacheKey = () => 'asphalt-v2';
}

/** Lane markings: chipped and faded in places (world-space noise). */
function patchWorn(material) {
  material.onBeforeCompile = (shader) => {
    addWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec4 nz = texture2D(uNoise, vRoadPos.xz * 0.06);
        float worn = smoothstep(0.5, 0.75, nz.b * 0.6 + nz.g * 0.5);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12), worn * 0.75);
        diffuseColor.rgb *= 0.85 + nz.r * 0.15;
      }`);
  };
  material.customProgramCacheKey = () => 'markings-worn-v1';
}

/** Manhole covers in the lanes and crack decals scattered over the asphalt. */
function buildDecals(layout, quad) {
  const group = new THREE.Group();
  const rng = createRng(layout.cfg.seed + 55);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const hr = layout.cfg.roadWidth / 2;
  const holes = [];
  const cracks = [];
  for (const alongZ of [true, false]) {
    const fixed = alongZ ? layout.roadX : layout.roadZ;
    const cross = alongZ ? layout.roadZ : layout.roadX;
    for (const c of fixed) {
      for (let j = 0; j < cross.length - 1; j++) {
        const a0 = cross[j] + hr + 6;
        const a1 = cross[j + 1] - hr - 6;
        if (rng.chance(0.55)) {
          const along = rng.range(a0, a1);
          const lat = rng.pick([-1, 1]) * rng.range(1.5, 4.5);
          holes.push(alongZ ? [c + lat, along] : [along, c + lat]);
        }
        const n = rng.int(1, 4);
        for (let k = 0; k < n; k++) {
          const along = rng.range(a0, a1);
          const lat = rng.range(-hr + 0.8, hr - 0.8);
          cracks.push([alongZ ? c + lat : along, alongZ ? along : c + lat, rng() * Math.PI, rng.range(1.5, 4)]);
        }
      }
    }
  }
  const decalMat = (tex, opts = {}) => new THREE.MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 0.6, metalness: opts.metal ?? 0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const hole = new THREE.InstancedMesh(quad, decalMat(makeManholeTexture(), { metal: 0.6 }), Math.max(holes.length, 1));
  holes.forEach(([x, z], i) => hole.setMatrixAt(i, m.compose(p.set(x, 0.018, z), q.setFromAxisAngle(up, rng() * 6.28), s.set(1.1, 1, 1.1))));
  hole.count = holes.length;
  const crack = new THREE.InstancedMesh(quad, decalMat(makeCrackTexture()), Math.max(cracks.length, 1));
  cracks.forEach(([x, z, a, sz], i) => crack.setMatrixAt(i, m.compose(p.set(x, 0.012, z), q.setFromAxisAngle(up, a), s.set(sz, 1, sz))));
  crack.count = cracks.length;
  for (const mesh of [hole, crack]) {
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    group.add(mesh);
  }
  return group;
}

function makeManholeTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const r = size / 2;
  ctx.fillStyle = '#2b2b2c';
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#4a4a4c';
  ctx.lineWidth = 5;
  ctx.stroke();
  // Raised grip pattern.
  ctx.strokeStyle = '#3d3d3f';
  ctx.lineWidth = 3;
  for (let k = -r; k < r; k += 11) {
    ctx.beginPath();
    ctx.moveTo(r + k, 8);
    ctx.lineTo(r + k, size - 8);
    ctx.moveTo(8, r + k);
    ctx.lineTo(size - 8, r + k);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCrackTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const rng = createRng(4242);
  ctx.strokeStyle = 'rgba(12,12,12,0.85)';
  ctx.lineCap = 'round';
  const branch = (x, y, a, len, w) => {
    if (len < 6 || w < 0.4) return;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    let cx = x;
    let cy = y;
    for (let i = 0; i < 6; i++) {
      a += rng.range(-0.5, 0.5);
      cx += Math.cos(a) * len / 6;
      cy += Math.sin(a) * len / 6;
      ctx.lineTo(cx, cy);
      if (rng.chance(0.25)) branch(cx, cy, a + rng.range(-1.2, 1.2), len * 0.5, w * 0.6);
    }
    ctx.stroke();
  };
  branch(20, size / 2, 0, size * 0.85, 2.6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
