import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { getVehicleShape, getUnitGeometries, extrudeProfile } from './vehicleShapes.js';

/**
 * The player's car: full hierarchy built from a procedural vehicle shape,
 * with steerable wheels, real headlight beams, brake / reverse / indicator
 * lamps and a cockpit interior for the first-person camera.
 *
 * Car local axes: +Z forward, +Y up, +X = driver's left.
 */
export function createPlayerCar(shapeType = 'sedan', color = CONFIG.player.color) {
  const shape = getVehicleShape(shapeType);
  const g = shape.geo;
  const u = getUnitGeometries();
  const root = new THREE.Group();
  root.name = 'playerCar';

  // `body` carries roll/pitch; wheels stay attached to `root`.
  const body = new THREE.Group();
  root.add(body);

  const paintMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.35 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1a2430, roughness: 0.08, metalness: 0.7, transparent: true, opacity: 0.72,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8 });
  const secondaryMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.5 });

  // Paint geometry is cloned so crash damage can dent this car only.
  const paint = new THREE.Mesh(g.paint.clone(), paintMat);
  const cabin = new THREE.Mesh(g.glass, glassMat);
  const trim = new THREE.Mesh(g.trim, trimMat);
  paint.castShadow = trim.castShadow = cabin.castShadow = true;
  body.add(paint, cabin, trim);
  if (g.secondary) body.add(new THREE.Mesh(g.secondary, secondaryMat));

  // Lamps -------------------------------------------------------------------
  const lampMat = (color, emissive, intensity) =>
    new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: intensity });
  const headMat = lampMat(0xf4f4f0, 0xfff3d6, 0.2);
  const tailMat = lampMat(0x6a0b0b, 0xff1a1a, 0.3);
  const revMat = lampMat(0xd8d8d8, 0xffffff, 0);
  const indMats = [lampMat(0x8a5a10, 0xffa21a, 0), lampMat(0x8a5a10, 0xffa21a, 0)];
  const addLamps = (list, mat) => {
    for (const [x, y, z, w, h] of list) {
      const m = new THREE.Mesh(u.lamp, mat);
      m.position.set(x, y, z);
      m.scale.set(w, h, 1);
      body.add(m);
    }
  };
  const L = shape.lamps;
  addLamps(L.head, headMat);
  addLamps(L.tail, tailMat);
  addLamps(L.reverse, revMat);
  for (const side of [0, 1]) {
    addLamps([L.indFront[side], L.indRear[side]], indMats[side]);
  }

  // Additive glow sprites over the lamps (brake lights flare when braking).
  const glowTex = getGlowTexture();
  const glowSprite = (color, [x, y, z], size, out) => {
    const m = new THREE.SpriteMaterial({
      map: glowTex, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(m);
    s.position.set(x, y, z + out);
    s.scale.setScalar(size);
    body.add(s);
    return s;
  };
  const tailGlows = L.tail.map((p) => glowSprite(0xff2a1a, p, 0.9, -0.08));
  const headGlows = L.head.map((p) => glowSprite(0xfff1d0, p, 1.3, 0.1));

  // Real headlight beams (no shadows by default: cheap enough for one car).
  const beams = [];
  const beamPower = 120 / L.head.length;
  for (const [x, y, z] of L.head) {
    const spot = new THREE.SpotLight(0xfff1d8, 0, 70, 0.52, 0.55, 1.4);
    spot.position.set(x, y, z);
    spot.target.position.set(x * 1.5, 0, z + 18);
    spot.shadow.mapSize.set(512, 512);
    spot.shadow.camera.near = 0.5;
    spot.shadow.bias = -0.0005;
    body.add(spot, spot.target);
    beams.push(spot);
  }

  // Interior + cockpit-only parts --------------------------------------------
  const ck = shape.cockpit;
  const inner = shape.width - 0.18;
  const interiorMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.9 });
  const interior = new THREE.Group();
  const dash = new THREE.Mesh(new THREE.BoxGeometry(inner, 0.3, 0.6), interiorMat);
  dash.position.set(0, ck.dash[0], ck.dash[1]);
  const seats = new THREE.Mesh(new THREE.BoxGeometry(Math.max(inner - 0.3, 0.5), 0.5, 0.5), interiorMat);
  seats.position.set(0, ck.dash[0] + 0.02, ck.eye[2] - 0.35);
  interior.add(dash, seats);
  body.add(interior);

  // Shown while the exterior shell is hidden: a hood slice, A-pillars, door
  // cards, floor, headliner and the steering wheel.
  const cockpit = new THREE.Group();
  cockpit.visible = false;
  const hood = new THREE.Mesh(extrudeProfile(ck.hood, ck.hoodWidth, 0.06), paintMat.clone());
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.9 });
  const headlinerMat = new THREE.MeshStandardMaterial({ color: 0x6a6d73, roughness: 1 });
  const floorY = ck.door ? ck.door[1] - 0.2 : 0.6;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(inner, 0.5, 0.9), darkMat);
  floor.position.set(0, floorY, 0.0);
  const [roofY, roofZ, roofLen, roofW] = ck.roof;
  const headliner = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.03, roofLen), headlinerMat);
  headliner.position.set(0, roofY, roofZ);
  cockpit.add(hood, floor, headliner);
  for (const side of [1, -1]) {
    if (ck.door) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 2.0), interiorMat);
      door.position.set(side * ck.door[0], ck.door[1], -0.15);
      cockpit.add(door);
    }
    const a = new THREE.Vector3(side * ck.pillarBase[0], ck.pillarBase[1], ck.pillarBase[2]);
    const b = new THREE.Vector3(side * ck.pillarTop[0], ck.pillarTop[1], ck.pillarTop[2]);
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, a.distanceTo(b)), darkMat);
    pillar.position.copy(a).add(b).multiplyScalar(0.5);
    pillar.lookAt(b);
    cockpit.add(pillar);
  }
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.026, 6, 18), darkMat);
  wheelRing.position.set(ck.eye[0], ck.wheel[0], ck.wheel[1]);
  wheelRing.rotation.x = -0.5;
  cockpit.add(wheelRing);
  body.add(cockpit);

  // Wheels: pivot (steering, yaw) -> spinner (rolling, pitch).
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.25, metalness: 0.8 });
  const r = shape.wheelRadius;
  const wheels = shape.wheels.map(([x, z, front]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    const spinner = new THREE.Group();
    const tyre = new THREE.Mesh(u.wheel, tyreMat);
    tyre.castShadow = true;
    const rim = new THREE.Mesh(u.rim, rimMat);
    spinner.scale.set(shape.wheelWidth, r, r);
    spinner.add(tyre, rim);
    pivot.add(spinner);
    root.add(pivot);
    return { pivot, spinner, front };
  });

  const materials = [paintMat, glassMat, trimMat, secondaryMat, headMat, tailMat, revMat, ...indMats,
    interiorMat, darkMat, headlinerMat, tyreMat, rimMat, hood.material];

  return {
    root,
    body,
    wheels,
    interior,
    shape,
    paint,
    paintMat,
    beams,
    reflective: [paintMat, glassMat, rimMat, hood.material],
    steeringWheel: wheelRing,
    setColor(c) {
      paintMat.color.set(c);
      hood.material.color.set(c);
    },
    /**
     * Swap between exterior shell and cockpit interior. The shell stops
     * writing colour/depth but still renders into the shadow map, so the car
     * keeps its shadow in cockpit view.
     */
    setCockpit(on) {
      cockpit.visible = on;
      for (const g of headGlows) g.visible = !on;
      for (const m of [paintMat, glassMat, secondaryMat]) {
        m.colorWrite = !on;
        m.depthWrite = !on && m !== glassMat;
      }
    },
    /**
     * headlights: 0..1 (fades in at dusk), braking / reversing: bool,
     * indL / indR: current blink state of each indicator.
     */
    setLights(headlights, braking, reversing = false, indL = false, indR = false) {
      headMat.emissiveIntensity = 0.2 + headlights * 3;
      // Never toggle .visible on lights: changing the light count forces every
      // material to recompile (a visible hitch at dusk). Fade intensity instead.
      for (const b of beams) b.intensity = headlights * beamPower;
      tailMat.emissiveIntensity = braking ? 4 : 0.3 + headlights * 1.2;
      revMat.emissiveIntensity = reversing ? 2.5 : 0;
      for (const g of tailGlows) g.material.opacity = braking ? 0.9 : headlights * 0.35;
      for (const g of headGlows) g.material.opacity = headlights * 0.8;
      indMats[0].emissiveIntensity = indL ? 3 : 0;
      indMats[1].emissiveIntensity = indR ? 3 : 0;
    },
    /** Quality "High": the first beam casts shadows (one extra shadow map). */
    setHeadlightShadow(on) {
      beams[0].castShadow = on;
    },
    dispose() {
      root.removeFromParent();
      for (const g of [...tailGlows, ...headGlows]) g.material.dispose();
      paint.geometry.dispose();
      hood.geometry.dispose();
      for (const m of materials) m.dispose();
      root.traverse((o) => {
        if (o.isMesh && o.geometry.type === 'BoxGeometry') o.geometry.dispose();
      });
    },
  };
}

let glowTexture = null;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}
