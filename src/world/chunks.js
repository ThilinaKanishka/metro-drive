import * as THREE from 'three';

/**
 * Split many instances of one geometry into spatial chunks: one
 * InstancedMesh per grid cell, each with a tight bounding sphere. three.js
 * then frustum-culls whole chunks, both for the camera and, more
 * importantly, for the sun's shadow camera (which only covers the area
 * around the car). A single city-wide InstancedMesh can never be culled.
 *
 * items: [{ x, z, matrix: THREE.Matrix4, color?: THREE.Color }]
 * Returns a Group of InstancedMeshes (each tagged userData.chunk with its
 * grid key, so LOD sets built from the same items line up); `onMesh(mesh)`
 * customises each one.
 */
export function chunkedInstances(geometry, material, items, { chunk = 140, onMesh } = {}) {
  const group = new THREE.Group();
  const buckets = new Map();
  for (const it of items) {
    const key = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  for (const [key, list] of buckets) {
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.matrix);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData.chunk = key;
    onMesh?.(mesh);
    group.add(mesh);
  }
  return group;
}
