import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

/**
 * Procedural low-poly car. The silhouette is an extruded side profile, the
 * greenhouse (glass) a second narrower extrusion. Geometry is cached and
 * shared with the instanced traffic cars.
 *
 * Car local axes: +Z forward, +Y up, +X = driver's left.
 */
let cached = null;

/** Extrude a side profile (points as [forward, up]) across the car's width. */
function extrudeProfile(points, width, bevel) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // Shape X -> world +Z (forward), extrusion Z -> world -X; then centre on X.
  geo.rotateY(-Math.PI / 2);
  geo.translate((width - bevel * 2) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

export function getCarGeometries() {
  if (cached) return cached;
  const r = CONFIG.car.wheelRadius;

  const body = extrudeProfile(
    [[-2.12, 0.32], [2.1, 0.32], [2.18, 0.58], [2.05, 0.8], [0.9, 0.93], [-1.75, 0.98], [-2.14, 0.9], [-2.18, 0.42]],
    1.84, 0.06,
  );
  const cabin = extrudeProfile(
    [[0.95, 0.9], [0.18, 1.34], [-1.05, 1.34], [-1.82, 0.95]],
    1.62, 0.04,
  );
  const roof = new THREE.BoxGeometry(1.5, 0.05, 1.18).translate(0, 1.37, -0.44);
  const paint = mergeGeometries([body, roof]);

  // Dark trim: bumpers + side skirts.
  const trim = mergeGeometries([
    new THREE.BoxGeometry(1.7, 0.18, 0.12).translate(0, 0.4, 2.16),
    new THREE.BoxGeometry(1.7, 0.18, 0.12).translate(0, 0.42, -2.18),
    new THREE.BoxGeometry(1.88, 0.1, 2.4).translate(0, 0.33, 0),
  ]);

  const wheel = new THREE.CylinderGeometry(r, r, 0.26, 12).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.28, 8).rotateZ(Math.PI / 2);
  const headlight = new THREE.BoxGeometry(0.42, 0.12, 0.06);
  const taillight = new THREE.BoxGeometry(0.4, 0.12, 0.06);

  cached = { paint, cabin, trim, wheel, rim, headlight, taillight };
  return cached;
}

/** Wheel placement in car space: [x, z, isFront]. */
export const WHEEL_POSITIONS = [
  [0.8, 1.32, true], [-0.8, 1.32, true],
  [0.8, -1.3, false], [-0.8, -1.3, false],
];
export const HEADLIGHT_POSITIONS = [[0.6, 0.66, 2.17], [-0.6, 0.66, 2.17]];
export const TAILLIGHT_POSITIONS = [[0.62, 0.74, -2.17], [-0.62, 0.74, -2.17]];

/** The player's car: full hierarchy with steerable wheels and real headlights. */
export function createPlayerCar(color = CONFIG.player.color) {
  const g = getCarGeometries();
  const root = new THREE.Group();
  root.name = 'playerCar';

  // `body` carries roll/pitch; wheels stay attached to `root`.
  const body = new THREE.Group();
  root.add(body);

  const paintMat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1a2430, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.72,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 });

  const paint = new THREE.Mesh(g.paint, paintMat);
  const cabin = new THREE.Mesh(g.cabin, glassMat);
  const trim = new THREE.Mesh(g.trim, trimMat);
  paint.castShadow = trim.castShadow = true;
  cabin.castShadow = true;
  body.add(paint, cabin, trim);

  // Lamps -------------------------------------------------------------------
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, emissive: 0xfff3d6, emissiveIntensity: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x6a0b0b, emissive: 0xff1a1a, emissiveIntensity: 0.3 });
  for (const [x, y, z] of HEADLIGHT_POSITIONS) {
    const m = new THREE.Mesh(g.headlight, headMat);
    m.position.set(x, y, z);
    body.add(m);
  }
  for (const [x, y, z] of TAILLIGHT_POSITIONS) {
    const m = new THREE.Mesh(g.taillight, tailMat);
    m.position.set(x, y, z);
    body.add(m);
  }

  // Real headlight beams (no shadows: cheap enough for one car).
  const beams = [];
  for (const [x, y, z] of HEADLIGHT_POSITIONS) {
    const spot = new THREE.SpotLight(0xfff1d8, 0, 70, 0.52, 0.55, 1.4);
    spot.position.set(x, y, z);
    spot.target.position.set(x * 1.5, 0, z + 18);
    body.add(spot, spot.target);
    beams.push(spot);
  }

  // Simple interior, visible through the glass and from the cockpit camera.
  const interiorMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.9 });
  const interior = new THREE.Group();
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.22, 0.45), interiorMat);
  dash.position.set(0, 0.92, 0.72);
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 6, 16), interiorMat);
  wheelRing.position.set(CONFIG.camera.cockpitOffset[0], 0.95, 0.42);
  wheelRing.rotation.x = -0.35;
  const seats = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.5), interiorMat);
  seats.position.set(0, 0.75, -0.35);
  interior.add(dash, wheelRing, seats);
  body.add(interior);

  // Wheels: pivot (steering, yaw) -> spinner (rolling, pitch).
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.7 });
  const wheels = WHEEL_POSITIONS.map(([x, z, front]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, CONFIG.car.wheelRadius, z);
    const spinner = new THREE.Group();
    const tyre = new THREE.Mesh(g.wheel, tyreMat);
    tyre.castShadow = true;
    spinner.add(tyre, new THREE.Mesh(g.rim, rimMat));
    pivot.add(spinner);
    root.add(pivot);
    return { pivot, spinner, front };
  });

  return {
    root,
    body,
    wheels,
    interior,
    steeringWheel: wheelRing,
    /** headlights: 0..1 (fades in at dusk), braking: bool. */
    setLights(headlights, braking) {
      headMat.emissiveIntensity = 0.2 + headlights * 3;
      for (const b of beams) {
        b.intensity = headlights * 60;
        b.visible = headlights > 0.01;
      }
      tailMat.emissiveIntensity = braking ? 4 : 0.3 + headlights * 1.2;
    },
  };
}
