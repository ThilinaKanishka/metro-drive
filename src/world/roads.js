import * as THREE from 'three';

/**
 * Builds the ground plane, asphalt, raised sidewalks / parks, lane markings,
 * crosswalks, stop lines and the boundary wall. All repeated pieces are
 * InstancedMesh so the whole road network costs only a handful of draw calls.
 */
export function buildRoads(layout) {
  const group = new THREE.Group();
  group.name = 'roads';
  const cfg = layout.cfg;
  const rw = cfg.roadWidth;

  // --- Ground (grass outside the city) -------------------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(layout.extentX + 900, layout.extentZ + 900),
    new THREE.MeshStandardMaterial({ color: 0x6d8f4e, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  group.add(ground);

  // --- Asphalt covering the entire grid -----------------------------------
  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(layout.extentX + 3, layout.extentZ + 3),
    new THREE.MeshStandardMaterial({ color: 0x3b3d42, roughness: 0.92 }),
  );
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.receiveShadow = true;
  group.add(asphalt);

  // --- Sidewalk slabs (one per block) + park lawns -------------------------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.95 });
  const sidewalks = new THREE.InstancedMesh(unitBox, sidewalkMat, layout.blocks.length);
  const parks = layout.blocks.filter((b) => b.park);
  const lawnMat = new THREE.MeshStandardMaterial({ color: 0x5f9a45, roughness: 1 });
  const lawns = new THREE.InstancedMesh(unitBox, lawnMat, Math.max(parks.length, 1));
  const plazaMat = new THREE.MeshStandardMaterial({ color: 0xa29d93, roughness: 1 });
  const plazas = new THREE.InstancedMesh(unitBox, plazaMat, layout.blocks.length);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const h = cfg.sidewalkHeight;
  const inner = cfg.blockSize - cfg.sidewalkWidth * 2;
  let li = 0;
  let pi = 0;
  layout.blocks.forEach((b, i) => {
    sidewalks.setMatrixAt(i, m.compose(p.set(b.cx, h / 2, b.cz), q, s.set(b.size, h, b.size)));
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

  // --- Markings: flat quads with per-instance colour -----------------------
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const markings = [];
  const WHITE = new THREE.Color(0xf2f2ee);
  const YELLOW = new THREE.Color(0xf2c23a);
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
    roughness: 0.8,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const markMesh = new THREE.InstancedMesh(quad, markMat, markings.length);
  markings.forEach((mk, i) => {
    markMesh.setMatrixAt(i, m.compose(p.set(mk.x, 0.015, mk.z), q.identity(), s.set(mk.sx, 1, mk.sz)));
    markMesh.setColorAt(i, mk.color);
  });
  markMesh.receiveShadow = true;
  markMesh.instanceMatrix.needsUpdate = true;
  group.add(markMesh);

  // --- Boundary wall ------------------------------------------------------
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.9 });
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

  return group;
}
