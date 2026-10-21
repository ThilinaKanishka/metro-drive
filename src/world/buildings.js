import * as THREE from 'three';
import { shareUniforms } from './shared.js';

/**
 * All buildings are one InstancedMesh of a unit box. Windows are not geometry:
 * a small shader patch draws a window grid in world space on every wall and
 * lights a random subset of them when `uNight` rises.
 */
export function buildBuildings(layout) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const list = layout.buildings;

  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05 });
  patchWindowShader(mat);

  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  list.forEach((b, i) => {
    mesh.setMatrixAt(i, m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d)));
    mesh.setColorAt(i, c.set(b.color));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  // Rooftop clutter: AC units / water tanks / parapets for a more lived-in skyline.
  const rng = layout.rng;
  const roofItems = [];
  for (const b of list) {
    const top = b.y + b.h;
    // Skip podiums that have a tower on them (tower sits at y = top).
    if (list.some((o) => o !== b && o.y === top && o.x === b.x && o.z === b.z)) continue;
    const n = rng.int(0, 3);
    for (let k = 0; k < n; k++) {
      const w = rng.range(1.2, 3.5);
      const d = rng.range(1.2, 3.5);
      const hh = rng.range(0.8, 2.6);
      roofItems.push({
        x: b.x + rng.range(-b.w / 2 + w, b.w / 2 - w) * 0.8,
        z: b.z + rng.range(-b.d / 2 + d, b.d / 2 - d) * 0.8,
        y: top, w, d, h: hh,
      });
    }
  }
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8b8e94, roughness: 0.9 });
  const roof = new THREE.InstancedMesh(geo, roofMat, Math.max(roofItems.length, 1));
  roofItems.forEach((r, i) => roof.setMatrixAt(i, m.compose(p.set(r.x, r.y, r.z), q, s.set(r.w, r.h, r.d))));
  roof.count = roofItems.length;
  roof.castShadow = true;
  group.add(roof);

  return group;
}

/** Inject world-space window pattern + night emissive into a standard material. */
function patchWindowShader(material) {
  material.onBeforeCompile = (shader) => {
    shareUniforms(shader);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 wp = vec4(transformed, 1.0);
        vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          wn = mat3(instanceMatrix) * wn;
        #endif
        wp = modelMatrix * wp;
        vWPos = wp.xyz;
        vWNormal = normalize(mat3(modelMatrix) * wn);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        float winHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float wall = 1.0 - step(0.5, abs(vWNormal.y));
          // Pick the horizontal axis that runs along this wall.
          float u = abs(vWNormal.x) > 0.5 ? vWPos.z : vWPos.x;
          vec2 cellSize = vec2(3.0, 3.4);
          vec2 cellId = floor(vec2(u, vWPos.y) / cellSize);
          vec2 f = fract(vec2(u, vWPos.y) / cellSize);
          float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.78);
          // No windows at street level (shop fronts get a band instead).
          win *= step(3.4, vWPos.y);
          win *= wall;
          float rnd = winHash(cellId + floor(vWPos.xz * 0.02 + vWNormal.xz * 7.0));
          // Glass: darker, slightly blue in daylight.
          vec3 glass = mix(vec3(0.16, 0.2, 0.27), vec3(0.32, 0.4, 0.5), rnd * 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.9);
          // Roofs: neutral grey.
          float roofMask = step(0.5, vWNormal.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.43, 0.45), roofMask * 0.8);
          // Ground floor shop band.
          float shop = wall * step(0.6, vWPos.y) * step(vWPos.y, 2.6) * step(0.1, f.x) * step(f.x, 0.9);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.14, 0.17), shop * 0.85);
          // Night lighting: random windows, warm/cool tints.
          float lit = step(0.6, rnd);
          vec3 warm = mix(vec3(1.0, 0.68, 0.32), vec3(0.6, 0.75, 1.0), step(0.88, rnd));
          totalEmissiveRadiance += win * lit * uNight * warm * (0.25 + 0.45 * rnd);
          totalEmissiveRadiance += shop * step(0.5, rnd) * uNight * vec3(1.0, 0.75, 0.45) * 0.3;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'building-windows-v1';
}
