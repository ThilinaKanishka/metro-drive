import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assets } from '../core/assets.js';
import { createRng } from '../core/utils.js';

/**
 * Extra city dressing:
 *  - street-name signs at junction corners (Kenney City Kit Roads model)
 *  - billboards on poles at block corners (generated ad atlas, lit at night)
 *  - a distant skyline: hazy tower silhouettes beyond the playable area,
 *    with lit windows at night (never fogged out, cheap unlit shader)
 *  - light cones under the street lamps at night (additive, soft-edged),
 *    re-assigned every half second to the lamps nearest the camera
 */
export class CityDetails {
  constructor(scene, layout) {
    this.layout = layout;
    this.group = new THREE.Group();
    this.group.name = 'cityDetails';
    this.rng = createRng(layout.cfg.seed + 777);
    this._buildSigns();
    this._buildBillboards();
    this._buildSkyline();
    this._buildLightCones();
    scene.add(this.group);
    this._coneTimer = 0;
  }

  _buildSigns() {
    const geo = assets.models?.props?.['road-sign-street'];
    if (!geo) return;
    const L = this.layout;
    const hr = L.cfg.roadWidth / 2;
    const g = geo.clone();
    g.computeBoundingBox();
    const k = 3.2 / (g.boundingBox.max.y - g.boundingBox.min.y);
    g.translate(0, -g.boundingBox.min.y, 0).scale(k, k, k);
    const items = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < L.roadX.length; i++) {
      for (let j = 0; j < L.roadZ.length; j++) {
        if (!this.rng.chance(0.4)) continue;
        // One of the four corners, on the sidewalk next to the crosswalk.
        const sx = this.rng.chance(0.5) ? 1 : -1;
        const sz = this.rng.chance(0.5) ? 1 : -1;
        const x = L.roadX[i] + sx * (hr + 2.9);
        const z = L.roadZ[j] + sz * (hr + 0.6);
        if (Math.abs(x) > L.halfX - 4 || Math.abs(z) > L.halfZ - 4) continue;
        const { ix, iz } = L.blockCoords(x, z);
        const bi = iz * L.cfg.blocksX + ix;
        if (!L.blocks[bi]) continue;
        items.push(m.compose(new THREE.Vector3(x, L.cfg.sidewalkHeight, z), q.setFromAxisAngle(up, this.rng() * 6.28), new THREE.Vector3(1, 1, 1)).clone());
        L._addCircle(bi, x, z, 0.12);
      }
    }
    const mesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }), items.length);
    items.forEach((mm, i) => mesh.setMatrixAt(i, mm));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildBillboards() {
    const L = this.layout;
    const rng = this.rng;
    const half = L.cfg.blockSize / 2;
    const atlas = makeAdAtlas();
    const panels = [];
    const frames = [];
    for (const b of L.blocks) {
      if (b.park || !rng.chance(0.35)) continue;
      // On the plaza corner, facing diagonally out over the junction.
      const sx = rng.chance(0.5) ? 1 : -1;
      const sz = rng.chance(0.5) ? 1 : -1;
      const x = b.cx + sx * (half - 4.2);
      const z = b.cz + sz * (half - 4.2);
      const yaw = Math.atan2(sx, sz);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, 1, 1));
      const ad = rng.int(0, 3);
      const face = new THREE.PlaneGeometry(6, 3).translate(0, 8.5, 0.18);
      const uv = face.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (ad % 2 + uv.getX(i)) / 2, (1 - Math.floor(ad / 2)) * 0.5 + uv.getY(i) * 0.5);
      panels.push(face.applyMatrix4(m));
      frames.push(
        new THREE.BoxGeometry(6.4, 3.4, 0.3).translate(0, 8.5, 0).applyMatrix4(m),
        new THREE.CylinderGeometry(0.22, 0.28, 7, 8).translate(0, 3.5, 0).applyMatrix4(m),
      );
      const { ix, iz } = L.blockCoords(x, z);
      L._addCircle(iz * L.cfg.blocksX + ix, x, z, 0.3);
    }
    if (!panels.length) return;
    this.adMat = new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: 0xffffff, emissiveIntensity: 0.1, roughness: 0.5 });
    const strip = (g) => {
      for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
      return g.index ? g.toNonIndexed() : g;
    };
    const faceMesh = new THREE.Mesh(mergeGeometries(panels), this.adMat);
    const frameMesh = new THREE.Mesh(mergeGeometries(frames.map(strip)), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 }));
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;
    this.group.add(faceMesh, frameMesh);
  }

  _buildSkyline() {
    const L = this.layout;
    const rng = createRng(L.cfg.seed + 4040);
    const n = 160;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.skylineUniforms = { uNight: { value: 0 }, uHaze: { value: new THREE.Color() } };
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.skylineUniforms.uNight;
      shader.uniforms.uHaze = this.skylineUniforms.uHaze;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSkyPos;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vSkyPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight;
          uniform vec3 uHaze;
          varying vec3 vSkyPos;
          float skyHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // Far away: mostly haze, slightly darker toward the ground.
            float h = clamp(vSkyPos.y / 120.0, 0.0, 1.0);
            vec3 sil = uHaze * mix(0.42, 0.68, h);
            vec2 g = vec2(vSkyPos.x + vSkyPos.z, vSkyPos.y) / vec2(2.6, 3.2);
            vec2 f = fract(g);
            float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.8);
            float lit = step(0.86, skyHash(floor(g))) * win * uNight;
            diffuseColor.rgb = sil * (1.0 - uNight * 0.6) + vec3(1.0, 0.75, 0.42) * lit * 0.4;
          }`);
    };
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.02, 0.02);
      const r = rng.range(Math.max(L.halfX, L.halfZ) + 260, Math.max(L.halfX, L.halfZ) + 380);
      const h = rng.range(18, 110) * (rng.chance(0.15) ? 1.6 : 1);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 3);
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r), q, new THREE.Vector3(rng.range(14, 34), h, rng.range(14, 34))));
    }
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  _buildLightCones() {
    const L = this.layout;
    this.lamps = L.streetLights.map((l) => ({ x: l.x + l.nx * 2.2, z: l.z + l.nz * 2.2 }));
    const h = 6.2;
    const geo = new THREE.CylinderGeometry(0.25, 3.4, h, 20, 1, true).translate(0, h / 2, 0);
    this.coneMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uStrength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vH;
        varying float vEdge;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vec3 n = normalize(mat3(modelMatrix * instanceMatrix) * normal);
          vec3 v = normalize(cameraPosition - wp.xyz);
          vEdge = abs(dot(n, v));
          vH = position.y / ${h.toFixed(1)};
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying float vH;
        varying float vEdge;
        void main() {
          // Brighter near the lamp, soft silhouette edges.
          float a = pow(vH, 1.6) * smoothstep(0.0, 0.6, vEdge) * uStrength;
          gl_FragColor = vec4(vec3(1.0, 0.78, 0.48) * a * 0.22, 1.0);
        }`,
    });
    this.cones = new THREE.InstancedMesh(geo, this.coneMat, 60);
    this.cones.count = 0;
    this.cones.frustumCulled = false;
    this.cones.renderOrder = 6;
    this.group.add(this.cones);
  }

  /** night 0..1; eye: camera position; haze: fog colour. */
  update(dt, night, eye, haze) {
    this.skylineUniforms.uNight.value = night;
    this.skylineUniforms.uHaze.value.copy(haze);
    const on = THREE.MathUtils.smoothstep(night, 0.35, 0.65);
    if (this.adMat) this.adMat.emissiveIntensity = 0.1 + on * 1.3;
    this.coneMat.uniforms.uStrength.value = on;
    this.cones.visible = on > 0.01;
    this._coneTimer -= dt;
    if (!this.cones.visible || this._coneTimer > 0) return;
    this._coneTimer = 0.5;
    const near = this.lamps
      .map((l) => ({ l, d: (l.x - eye.x) ** 2 + (l.z - eye.z) ** 2 }))
      .filter((o) => o.d < 140 * 140)
      .sort((a, b) => a.d - b.d)
      .slice(0, 60);
    const m = new THREE.Matrix4();
    near.forEach((o, i) => this.cones.setMatrixAt(i, m.makeTranslation(o.l.x, 0.05, o.l.z)));
    this.cones.count = near.length;
    this.cones.instanceMatrix.needsUpdate = true;
  }
}

function makeAdAtlas() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');
  const ads = [
    ['#0f4c81', '#4fc3f7', 'NOVA', 'phones'],
    ['#b3261e', '#ffb74d', 'SPARK', 'energy drink'],
    ['#1b5e20', '#a5d6a7', 'GREENLINE', 'city bikes'],
    ['#311b92', '#ff80ab', 'NEON NIGHTS', 'live music'],
  ];
  ads.forEach(([bg, fg, title, sub], i) => {
    const x = (i % 2) * 512;
    const y = Math.floor(i / 2) * 256;
    const g = ctx.createLinearGradient(x, y, x + 512, y + 256);
    g.addColorStop(0, bg);
    g.addColorStop(1, '#111');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 512, 256);
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.arc(x + 420, y + 128, 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '900 64px system-ui, sans-serif';
    ctx.fillText(title, x + 30, y + 130, 360);
    ctx.font = '600 28px system-ui, sans-serif';
    ctx.fillStyle = fg;
    ctx.fillText(sub, x + 34, y + 180);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
