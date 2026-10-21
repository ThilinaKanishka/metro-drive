import * as THREE from 'three';

/**
 * Low-poly trees: shared trunk mesh + two foliage styles (round and conifer),
 * all InstancedMesh with per-instance colour variation.
 */
export function buildTrees(layout) {
  const group = new THREE.Group();
  group.name = 'trees';
  const all = [...layout.trees, ...layout.outerTrees];

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 2.4, 6).translate(0, 1.2, 0);
  const roundGeo = new THREE.IcosahedronGeometry(1.6, 0).translate(0, 3.4, 0);
  const coneGeo = new THREE.ConeGeometry(1.5, 4.2, 7).translate(0, 4.0, 0);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, all.length);
  const rounds = new THREE.InstancedMesh(roundGeo, leafMat, all.length);
  const cones = new THREE.InstancedMesh(coneGeo, leafMat, all.length);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  let ri = 0;
  let ci = 0;

  all.forEach((t, i) => {
    q.setFromAxisAngle(up, t.hue * Math.PI * 2);
    m.compose(p.set(t.x, 0, t.z), q, s.setScalar(t.scale));
    trunks.setMatrixAt(i, m);
    const conifer = t.hue > 0.72;
    // Greens ranging from yellow-ish to deep, a few autumn tints.
    if (t.hue < 0.06) c.setHSL(0.08, 0.6, 0.45);
    else c.setHSL(0.22 + t.hue * 0.12, 0.45 + t.hue * 0.2, conifer ? 0.26 : 0.34 + t.hue * 0.08);
    if (conifer) {
      cones.setMatrixAt(ci, m);
      cones.setColorAt(ci++, c);
    } else {
      // Slightly squash round crowns for variety.
      m.compose(p, q, s.set(t.scale, t.scale * (0.85 + t.hue * 0.3), t.scale));
      rounds.setMatrixAt(ri, m);
      rounds.setColorAt(ri++, c);
    }
  });
  rounds.count = ri;
  cones.count = ci;

  for (const mesh of [trunks, rounds, cones]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }
  return group;
}
