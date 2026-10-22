import * as THREE from 'three';
import { chunkedInstances } from './chunks.js';

/**
 * Low-poly trees: trunk + two foliage styles (round and conifer), instanced
 * in spatial chunks (culled per chunk for the camera and shadow map) with
 * per-instance colour variation. Foliage sways in the wind in the vertex
 * shader (amplitude grows with height; phase varies per tree).
 */
export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: 0.35 },   // 0 calm .. 1 stormy (weather raises it)
};

export function buildTrees(layout) {
  const group = new THREE.Group();
  group.name = 'trees';
  const all = [...layout.trees, ...layout.outerTrees];

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 6).translate(0, 1.2, 0);
  const roundGeo = new THREE.IcosahedronGeometry(1.6, 1).translate(0, 3.4, 0);
  const coneGeo = new THREE.ConeGeometry(1.5, 4.2, 8).translate(0, 4.0, 0);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5e4330, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true });
  addWind(leafMat);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const trunks = [];
  const rounds = [];
  const cones = [];

  for (const t of all) {
    q.setFromAxisAngle(up, t.hue * Math.PI * 2);
    m.compose(p.set(t.x, 0, t.z), q, s.setScalar(t.scale));
    trunks.push({ x: t.x, z: t.z, matrix: m.clone() });
    const conifer = t.hue > 0.72;
    // Greens ranging from yellow-ish to deep, a few autumn tints.
    const c = new THREE.Color();
    if (t.hue < 0.06) c.setHSL(0.08, 0.6, 0.45);
    else c.setHSL(0.22 + t.hue * 0.12, 0.45 + t.hue * 0.2, conifer ? 0.26 : 0.34 + t.hue * 0.08);
    if (conifer) {
      cones.push({ x: t.x, z: t.z, matrix: m.clone(), color: c });
    } else {
      // Slightly squash round crowns for variety.
      const mm = new THREE.Matrix4().compose(p, q, s.set(t.scale, t.scale * (0.85 + t.hue * 0.3), t.scale));
      rounds.push({ x: t.x, z: t.z, matrix: mm, color: c });
    }
  }

  const shadowy = (mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  };
  group.add(
    chunkedInstances(trunkGeo, trunkMat, trunks, { onMesh: shadowy }),
    chunkedInstances(roundGeo, leafMat, rounds, { onMesh: shadowy }),
    chunkedInstances(coneGeo, leafMat, cones, { onMesh: shadowy }),
  );
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
