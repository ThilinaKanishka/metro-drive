import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { chunkedInstances } from './chunks.js';

/**
 * Low-poly trees (round and conifer styles). Trunk and crown are merged into
 * one vertex-coloured geometry per style, so a tree is a single instance.
 * City trees are instanced in spatial chunks (culled per chunk for the
 * camera and the shadow map); the trees outside the city wall share one
 * mesh per style and cast no shadows. Per-instance colour varies the
 * foliage; foliage sways in the wind in the vertex shader.
 */
export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: 0.35 },   // 0 calm .. 1 stormy (weather raises it)
};

/** Geometry with a flat vertex colour (trunk / crown). */
function painted(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export function buildTrees(layout) {
  const group = new THREE.Group();
  group.name = 'trees';

  // Trunk colour is pre-divided by a typical foliage tint so that, after the
  // per-instance (green) colour multiplies it, it still reads as bark.
  const trunk = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 6).translate(0, 1.2, 0);
  const roundGeo = mergeGeometries([
    painted(trunk.clone(), 0x9a7a70),
    painted(new THREE.IcosahedronGeometry(1.6, 1).translate(0, 3.4, 0), 0xffffff),
  ]);
  const coneGeo = mergeGeometries([
    painted(trunk.clone(), 0x9a7a70),
    painted(new THREE.ConeGeometry(1.5, 4.2, 8).translate(0, 4.0, 0), 0xffffff),
  ]);
  const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  addWind(leafMat);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const sets = { rounds: [], cones: [], outerRounds: [], outerCones: [] };
  const place = (t, outer) => {
    q.setFromAxisAngle(up, t.hue * Math.PI * 2);
    const conifer = t.hue > 0.72;
    // Greens ranging from yellow-ish to deep, a few autumn tints.
    const c = new THREE.Color();
    if (t.hue < 0.06) c.setHSL(0.08, 0.6, 0.45);
    else c.setHSL(0.22 + t.hue * 0.12, 0.45 + t.hue * 0.2, conifer ? 0.26 : 0.34 + t.hue * 0.08);
    // Slightly squash round crowns for variety.
    s.set(t.scale, conifer ? t.scale : t.scale * (0.85 + t.hue * 0.3), t.scale);
    const item = { x: t.x, z: t.z, matrix: m.compose(p.set(t.x, 0, t.z), q, s).clone(), color: c };
    sets[(outer ? 'outer' : '') + (conifer ? (outer ? 'Cones' : 'cones') : (outer ? 'Rounds' : 'rounds'))].push(item);
  };
  for (const t of layout.trees) place(t, false);
  for (const t of layout.outerTrees) place(t, true);

  const shadowy = (mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  };
  const city = new THREE.Group();
  city.add(
    chunkedInstances(roundGeo, leafMat, sets.rounds, { chunk: 200, onMesh: shadowy }),
    chunkedInstances(coneGeo, leafMat, sets.cones, { chunk: 200, onMesh: shadowy }),
  );
  // Outside the walls: one mesh per style, no shadows (never near the car).
  const outer = new THREE.Group();
  outer.add(
    chunkedInstances(roundGeo, leafMat, sets.outerRounds, { chunk: 100000 }),
    chunkedInstances(coneGeo, leafMat, sets.outerCones, { chunk: 100000 }),
  );
  group.add(city, outer);
  group.userData.city = city;
  group.userData.items = { rounds: sets.rounds, cones: sets.cones };
  return group;
}

/**
 * Wind sway: bend the crown around the tree base, more at the top, with a
 * per-tree phase from its world position and a fast flutter on top.
 */
export function addWind(material, strength = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 base = vec3(0.0);
          #ifdef USE_INSTANCING
            base = instanceMatrix[3].xyz;
          #endif
          float phase = dot(base.xz, vec2(0.13, 0.07));
          float h = max(transformed.y - 1.5, 0.0);
          float sway = (sin(uTime * 1.3 + phase) * 0.6 + sin(uTime * 2.7 + phase * 1.7) * 0.25) * uWind;
          float flutter = sin(uTime * 7.0 + dot(transformed, vec3(3.1, 2.3, 1.7))) * 0.03 * uWind;
          transformed.x += (sway * 0.06 * h * h + flutter) * ${strength.toFixed(2)};
          transformed.z += (sway * 0.035 * h * h + flutter) * ${strength.toFixed(2)};
        }`);
  };
  material.customProgramCacheKey = () => `wind-${strength}`;
}
