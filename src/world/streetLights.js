import * as THREE from 'three';

/**
 * Street lights. Real light sources are far too expensive at this count, so
 * each lamp is an emissive head plus an additive "light pool" decal on the
 * road whose opacity follows the night factor.
 */
export function buildStreetLights(layout) {
  const group = new THREE.Group();
  group.name = 'streetLights';
  const lights = layout.streetLights;
  const n = lights.length;

  const poleH = 6.5;
  const armLen = 2.2;
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, poleH, 6).translate(0, poleH / 2, 0);
  const armGeo = new THREE.BoxGeometry(0.1, 0.1, armLen).translate(0, 0, armLen / 2);
  const headGeo = new THREE.BoxGeometry(0.45, 0.14, 0.8);

  const metal = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.6, metalness: 0.4 });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4,
  });

  const poles = new THREE.InstancedMesh(poleGeo, metal, n);
  const arms = new THREE.InstancedMesh(armGeo, metal, n);
  const heads = new THREE.InstancedMesh(headGeo, headMat, n);

  // Light pool decal (radial gradient generated on a canvas).
  const poolTex = makeRadialTexture();
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTex, color: 0xffc887, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const pools = new THREE.InstancedMesh(poolGeo, poolMat, n);
  pools.renderOrder = 2;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);

  lights.forEach((l, i) => {
    // Arm geometry points along +Z; rotate so it points along the outward normal.
    const yaw = Math.atan2(l.nx, l.nz);
    q.setFromAxisAngle(up, yaw);
    poles.setMatrixAt(i, m.compose(p.set(l.x, 0, l.z), q, s.set(1, 1, 1)));
    arms.setMatrixAt(i, m.compose(p.set(l.x, poleH - 0.1, l.z), q, s));
    const hx = l.x + l.nx * armLen;
    const hz = l.z + l.nz * armLen;
    heads.setMatrixAt(i, m.compose(p.set(hx, poleH - 0.18, hz), q, s));
    pools.setMatrixAt(i, m.compose(p.set(hx, 0.04, hz), q, s.set(13, 1, 13)));
  });

  poles.castShadow = true;
  arms.castShadow = true;
  for (const mesh of [poles, arms, heads, pools]) {
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return {
    group,
    /** night: 0..1 */
    update(night) {
      const on = THREE.MathUtils.smoothstep(night, 0.35, 0.65);
      headMat.emissiveIntensity = on * 3.0;
      poolMat.opacity = on * 0.55;
      pools.visible = on > 0.01;
    },
  };
}

function makeRadialTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
