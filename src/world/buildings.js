import * as THREE from 'three';
import { shareUniforms, worldUniforms } from './shared.js';
import { assets } from '../core/assets.js';
import { createRng } from '../core/utils.js';

/**
 * Buildings, split into spatial chunks (2×2 blocks each) so the camera and
 * the sun's shadow camera can cull whole chunks: shadows are only rendered
 * for buildings near the car instead of the entire city every frame.
 *
 * Facades are not geometry: a shader patch on MeshStandardMaterial draws, in
 * world space, one of four facade types per building (instance attribute):
 *   0 concrete offices   1 brick   2 glass curtain-wall tower   3 painted plaster
 * with window grids, a glazed shop floor, glossy window glass with a cheap
 * sky reflection (real reflections when scene IBL is on), and lit windows
 * (some with blinds) at night. Brick / concrete use PBR textures with normal
 * mapping up close; distant chunks switch to a texture-free LOD variant.
 */
export const facadeUniforms = {
  uSkyColor: { value: new THREE.Color(0x9fb8d0) },
};

const LOD_DISTANCE = 230;
const ROOF_DISTANCE = 260;

export function buildBuildings(layout) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const list = layout.buildings;
  const rng = createRng(layout.cfg.seed + 909);

  // Facade type per building: towers downtown are often glass.
  const facades = list.map((b) => {
    const tall = b.y + b.h;
    const r = rng();
    if (b.y > 0 || tall > 45) return r < 0.55 ? 2 : r < 0.85 ? 0 : 3;
    if (tall > 22) return r < 0.35 ? 0 : r < 0.65 ? 1 : r < 0.8 ? 2 : 3;
    return r < 0.45 ? 1 : r < 0.75 ? 3 : 0;
  });

  const near = makeFacadeMaterial(false);
  const far = makeFacadeMaterial(true);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8b8e94, roughness: 0.9 });

  // Bucket buildings + rooftop items by chunk.
  const chunkBlocks = 2;
  const chunksX = Math.ceil(layout.cfg.blocksX / chunkBlocks);
  const buckets = new Map();
  const chunkOf = (x, z) => {
    const { ix, iz } = layout.blockCoords(x, z);
    const cx = Math.min(Math.max(Math.floor(ix / chunkBlocks), 0), chunksX - 1);
    const cz = Math.max(Math.floor(iz / chunkBlocks), 0);
    const key = cz * chunksX + cx;
    if (!buckets.has(key)) buckets.set(key, { buildings: [], roofs: [] });
    return buckets.get(key);
  };
  list.forEach((b, i) => chunkOf(b.x, b.z).buildings.push(i));

  // Rooftop clutter: AC units / water tanks / parapets for a more lived-in skyline.
  for (const b of list) {
    const top = b.y + b.h;
    // Skip podiums that have a tower on them (tower sits at y = top).
    if (list.some((o) => o !== b && o.y === top && o.x === b.x && o.z === b.z)) continue;
    const n = layout.rng.int(0, 3);
    for (let k = 0; k < n; k++) {
      const w = layout.rng.range(1.2, 3.5);
      const d = layout.rng.range(1.2, 3.5);
      const hh = layout.rng.range(0.8, 2.6);
      chunkOf(b.x, b.z).roofs.push({
        x: b.x + layout.rng.range(-b.w / 2 + w, b.w / 2 - w) * 0.8,
        z: b.z + layout.rng.range(-b.d / 2 + d, b.d / 2 - d) * 0.8,
        y: top, w, d, h: hh,
      });
    }
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const chunks = [];
  for (const { buildings, roofs } of buckets.values()) {
    const g = geo.clone();
    const attr = new Float32Array(buildings.length * 2);
    buildings.forEach((bi, k) => {
      attr[k * 2] = facades[bi];
      attr[k * 2 + 1] = rng();
    });
    g.setAttribute('aFacade', new THREE.InstancedBufferAttribute(attr, 2));
    const mesh = new THREE.InstancedMesh(g, near, buildings.length);
    buildings.forEach((bi, k) => {
      const b = list[bi];
      mesh.setMatrixAt(k, m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d)));
      // Glass towers keep a neutral tint; others use the palette colour.
      mesh.setColorAt(k, facades[bi] === 2 ? c.set(0xbfc8d2) : c.set(b.color));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);

    let roof = null;
    if (roofs.length) {
      roof = new THREE.InstancedMesh(geo, roofMat, roofs.length);
      roofs.forEach((r, k) => roof.setMatrixAt(k, m.compose(p.set(r.x, r.y, r.z), q, s.set(r.w, r.h, r.d))));
      roof.castShadow = true;
      roof.computeBoundingSphere();
      group.add(roof);
    }
    chunks.push({ mesh, roof, center: mesh.boundingSphere.center.clone() });
  }

  return {
    group,
    chunks,
    /** Per frame: near / far facade LOD and rooftop details by distance. */
    update(eye) {
      for (const ch of chunks) {
        const d = Math.hypot(ch.center.x - eye.x, ch.center.z - eye.z);
        ch.mesh.material = d < LOD_DISTANCE ? near : far;
        if (ch.roof) ch.roof.visible = d < ROOF_DISTANCE;
      }
    },
  };
}

/** Facade shader patch; `farLod` drops textures and normal mapping. */
function makeFacadeMaterial(farLod) {
  const tex = assets.textures;
  const brick = tex.brick || {};
  const concrete = tex.concrete || {};
  const useTex = !farLod && brick.color && concrete.color;
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  material.onBeforeCompile = (shader) => {
    shareUniforms(shader);
    shader.uniforms.uSkyColor = facadeUniforms.uSkyColor;
    if (useTex) {
      shader.uniforms.uBrick = { value: brick.color };
      shader.uniforms.uBrickN = { value: brick.normal ?? brick.color };
      shader.uniforms.uConcrete = { value: concrete.color };
      shader.uniforms.uConcreteN = { value: concrete.normal ?? concrete.color };
    }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aFacade;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying vec2 vFacade;`)
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
        vWNormal = normalize(mat3(modelMatrix) * wn);
        vFacade = aFacade;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        ${useTex ? '#define FACADE_TEX' : ''}
        uniform float uNight;
        uniform vec3 uSkyColor;
        #ifdef FACADE_TEX
          uniform sampler2D uBrick;
          uniform sampler2D uBrickN;
          uniform sampler2D uConcrete;
          uniform sampler2D uConcreteN;
        #endif
        varying vec3 vWPos;
        varying vec3 vWNormal;
        varying vec2 vFacade;
        float winHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 fN = normalize(vWNormal);
        float wall = 1.0 - step(0.5, abs(fN.y));
        float roofMask = step(0.5, fN.y);
        // Wall frame: tangent along the wall (B = up, T = B x N).
        vec3 fT = normalize(cross(vec3(0.0, 1.0, 0.0), fN + vec3(0.0001)));
        vec2 wuv = vec2(dot(vWPos, fT), vWPos.y);
        float ftype = floor(vFacade.x + 0.5);
        float isBrick = step(0.5, ftype) * step(ftype, 1.5);
        float isGlass = step(1.5, ftype) * step(ftype, 2.5);
        float isPlaster = step(2.5, ftype);

        // Window grid per facade type.
        vec2 cellSize = mix(mix(vec2(3.0, 3.4), vec2(2.7, 3.2), isBrick), vec2(1.6, 3.6), isGlass);
        vec2 cellId = floor(wuv / cellSize);
        vec2 f = fract(wuv / cellSize);
        vec4 wr = mix(mix(vec4(0.17, 0.83, 0.24, 0.8), vec4(0.27, 0.73, 0.22, 0.82), isBrick), vec4(0.03, 0.97, 0.13, 0.99), isGlass);
        float win = step(wr.x, f.x) * step(f.x, wr.y) * step(wr.z, f.y) * step(f.y, wr.w);
        win *= wall * step(3.6, vWPos.y);
        // Ground floor: glazed shop fronts with mullions.
        float sf = fract(wuv.x / 2.4);
        float shop = wall * step(0.55, vWPos.y) * step(vWPos.y, 2.75) * step(0.06, sf) * step(sf, 0.94);
        float glass = max(win, shop);
        float rnd = winHash(cellId + floor(vWPos.xz * 0.02 + fN.xz * 7.0) + vFacade.y * 13.0);

        // Wall albedo.
        vec3 tint = diffuseColor.rgb;
        vec3 wallCol = tint;
        #ifdef FACADE_TEX
          vec3 brickTex = texture2D(uBrick, wuv * 0.35).rgb;
          vec3 concTex = texture2D(uConcrete, wuv * 0.22).rgb;
          wallCol = mix(concTex * tint * 1.1, brickTex * mix(vec3(1.0), tint, 0.25), isBrick);
          wallCol = mix(wallCol, (0.65 + 0.35 * concTex) * tint, isPlaster);
        #else
          wallCol = mix(tint, tint * vec3(0.75, 0.45, 0.38) + 0.08, isBrick);
        #endif
        // Glass tower: mullions / spandrels in a light metal.
        wallCol = mix(wallCol, vec3(0.62, 0.65, 0.68), isGlass);
        // Window glass: dark, blue-green for towers, with a hint of curtains.
        vec3 glassCol = mix(vec3(0.05, 0.06, 0.07), vec3(0.06, 0.1, 0.12), isGlass) + rnd * 0.03;
        diffuseColor.rgb = mix(wallCol, glassCol, glass * 0.92);
        // Roofs: concrete grey.
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.39, 0.4), roofMask * 0.85);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(0.88, 0.8, isPlaster), 0.4, isGlass);
        roughnessFactor = mix(roughnessFactor, 0.06, glass);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = mix(isGlass * 0.6, 0.35, glass);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #ifdef FACADE_TEX
          if (wall > 0.5 && glass < 0.5 && isGlass < 0.5) {
            vec3 nm = mix(texture2D(uConcreteN, wuv * 0.22).xyz, texture2D(uBrickN, wuv * 0.35).xyz, isBrick) * 2.0 - 1.0;
            vec3 tV = normalize((viewMatrix * vec4(fT, 0.0)).xyz);
            vec3 bV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
            normal = normalize(tV * nm.x * 0.9 + bV * nm.y * 0.9 + normal * nm.z);
          }
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Cheap sky reflection on glass (fresnel), dimmed at night.
          vec3 viewDir = normalize(cameraPosition - vWPos);
          float fres = pow(1.0 - max(dot(viewDir, fN), 0.0), 3.0);
          totalEmissiveRadiance += uSkyColor * glass * (0.08 + fres * 0.5) * (1.0 - uNight * 0.85);
          // Night: random lit windows, warm / cool, some with blinds.
          // Interior light falls off from the ceiling; some windows have
          // curtains (dim, warm) or blinds (stripes); offices are cooler.
          float lit = step(0.52, rnd);
          float r2 = fract(rnd * 7.13);
          vec3 warm = mix(vec3(1.0, 0.62, 0.28), vec3(0.65, 0.78, 1.0), step(0.86, r2));
          float wy = (f.y - wr.z) / (wr.w - wr.z);
          float ceiling = 0.45 + 0.55 * smoothstep(0.0, 1.0, wy);
          float blinds = mix(1.0, 0.5 + 0.5 * step(0.45, fract(wy * 8.0)), step(0.75, r2));
          float curtain = mix(1.0, 0.45, step(0.55, r2) * step(r2, 0.75));
          totalEmissiveRadiance += win * lit * uNight * warm * ceiling * blinds * curtain * (0.12 + 0.3 * r2);
          // Shops: each 2.4 m bay differs (closed, dim, bright), with shelves
          // and a brighter band near the ceiling.
          float bay = winHash(vec2(floor(wuv.x / 2.4), floor(vWPos.x * 0.1 + vWPos.z * 0.1)));
          float sy = (vWPos.y - 0.55) / 2.2;
          float shelves = 0.75 + 0.25 * step(0.5, fract(sy * 5.0 + bay));
          vec3 shopCol = mix(vec3(1.0, 0.8, 0.55), vec3(0.85, 0.92, 1.0), step(0.7, bay));
          totalEmissiveRadiance += shop * step(0.3, bay) * uNight * shopCol * shelves
            * (0.08 + 0.22 * bay) * (0.6 + 0.4 * smoothstep(0.3, 1.0, sy));
          // Street-light bounce: faint warm light on the lower floors at night.
          totalEmissiveRadiance += wall * uNight * vec3(0.9, 0.6, 0.35) * 0.018 * (1.0 - smoothstep(4.0, 22.0, vWPos.y));
        }`,
      );
  };
  material.customProgramCacheKey = () => `facade-v2-${useTex ? 'tex' : 'flat'}`;
  return material;
}

export { worldUniforms };
