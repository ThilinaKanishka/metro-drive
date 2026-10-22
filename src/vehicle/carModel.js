import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { getVehicleShape, getUnitGeometries, extrudeProfile } from './vehicleShapes.js';
import { createWindshield } from './windshield.js';
import { createDashboard } from './dashboard.js';

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

  // Car paint: metallic base under a glossy clear coat.
  const paintMat = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.42, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.06,
  });
  // Tinted glass: mostly reflection, a little see-through.
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0c1218, roughness: 0.03, metalness: 0.1, transparent: true, opacity: 0.68,
    specularIntensity: 1, envMapIntensity: 1.4,
  });
  // Satin black plastic for bumpers / skirts.
  // Trim carries per-vertex colours (black plastic, light bars, signs...).
  const trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  // Chrome / polished alloy (rims, grilles, bumpers on glTF models).
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.14, metalness: 1 });
  const secondaryMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.5 });

  // Paint geometry is cloned so crash damage can dent this car only.
  const paint = new THREE.Mesh(g.paint.clone(), paintMat);
  const cabin = new THREE.Mesh(g.glass, glassMat);
  const trim = new THREE.Mesh(g.trim, trimMat);
  paint.castShadow = trim.castShadow = cabin.castShadow = true;
  body.add(paint, cabin, trim);
  if (g.chrome) {
    const chrome = new THREE.Mesh(g.chrome, rimMat);
    chrome.castShadow = true;
    body.add(chrome);
  }
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

  // Headlight beams. Real spot lights are lit per pixel on every material in
  // the scene, which is expensive on integrated GPUs, so the quality preset
  // picks a mode (see setHeadlightMode):
  //   'decal' - no lights, an additive beam decal on the road (Low / Medium)
  //   'one'   - one centred spot light (High)
  //   'two'   - one per lamp, the first casting shadows (Ultra)
  // Lights are only visible at night; the game pre-compiles both light
  // counts so switching at dusk doesn't stall.
  const beams = [];
  const headZ = L.head[0][2];
  const headY = L.head[0][1];
  const lampX = L.head.length > 1 ? Math.abs(L.head[0][0]) : 0;
  for (const x of [lampX, -lampX]) {
    const spot = new THREE.SpotLight(0xfff1d8, 0, 70, 0.52, 0.55, 1.4);
    spot.position.set(x, headY, headZ);
    spot.target.position.set(x * 1.5, 0, headZ + 18);
    spot.shadow.mapSize.set(512, 512);
    spot.shadow.camera.near = 0.5;
    spot.shadow.bias = -0.0005;
    spot.visible = false;
    body.add(spot, spot.target);
    beams.push(spot);
  }
  let beamMode = 'decal';
  const beamDecal = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: getBeamTexture(), color: 0xfff0d0, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
  );
  beamDecal.scale.set(6, 1, 13);
  beamDecal.position.set(0, 0.06, headZ + 6.5);
  beamDecal.renderOrder = 2;
  root.add(beamDecal);

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

  // Cockpit-only parts, shown while the exterior shell is hidden: a hood
  // slice, A-pillars, door cards, floor, headliner and the steering wheel.
  const cockpit = new THREE.Group();
  cockpit.visible = false;
  const hood = new THREE.Mesh(
    ck.hood ? extrudeProfile(ck.hood, ck.hoodWidth, 0.06) : new THREE.BufferGeometry(),
    paintMat.clone(),
  );
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
  // Spokes (children of the rim, so they turn with it) and a hub.
  for (const a of [0, Math.PI * 0.5, Math.PI]) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.022, 0.018), darkMat);
    spoke.position.set(Math.cos(a) * 0.075, -Math.sin(a) * 0.075 * (a === Math.PI * 0.5 ? 1 : 0), 0);
    spoke.rotation.z = -a;
    wheelRing.add(spoke);
  }
  wheelRing.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12).rotateX(Math.PI / 2), darkMat));
  cockpit.add(wheelRing);
  const dashboard = createDashboard(ck, inner);
  cockpit.add(dashboard.group);
  const windshield = createWindshield(ck);
  cockpit.add(windshield.group);
  body.add(cockpit);

  // Wheels: pivot (steering, yaw) -> spinner (rolling, pitch).
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.92 });
  const r = shape.wheelRadius;
  const wheels = shape.wheels.map(([x, z, front]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    const spinner = new THREE.Group();
    const tyre = new THREE.Mesh(u.wheel, tyreMat);
    tyre.castShadow = true;
    const rim = new THREE.Mesh(u.rim, rimMat);
    spinner.scale.set(shape.wheelWidth, r, r);
    // Right-hand wheels are turned around so the rim faces outward.
    if (x < 0) spinner.rotation.y = Math.PI;
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
    /** Cockpit instruments: speed (km/h), rpm in thousands, indicators, night 0..1. */
    updateDashboard(kmh, rpmK, left, right, night) {
      if (cockpit.visible) dashboard.update(kmh, rpmK, left, right, night);
    },
    windshield,
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
      for (const m of [paintMat, glassMat, secondaryMat, trimMat, rimMat]) {
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
      const on = headlights > 0.02;
      beamDecal.visible = beamMode === 'decal' && on;
      beamDecal.material.opacity = headlights * 0.32;
      beams[0].visible = on && beamMode !== 'decal';
      beams[1].visible = on && beamMode === 'two';
      const power = beamMode === 'one' ? 120 : 60;
      for (const b of beams) b.intensity = headlights * power;
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
    /** 'decal' | 'one' | 'two' (see above). */
    setHeadlightMode(mode) {
      beamMode = mode;
      // A single beam sits on the centre line and spreads wider.
      beams[0].position.x = mode === 'one' ? 0 : lampX;
      beams[0].target.position.x = mode === 'one' ? 0 : lampX * 1.5;
      beams[0].angle = mode === 'one' ? 0.62 : 0.52;
    },
    /** Lights on for shader pre-compilation (see Game._warmUpShaders). */
    forceBeams(on) {
      beams[0].visible = on && beamMode !== 'decal';
      beams[1].visible = on && beamMode === 'two';
    },
    dispose() {
      root.removeFromParent();
      for (const g of [...tailGlows, ...headGlows]) g.material.dispose();
      beamDecal.geometry.dispose();
      beamDecal.material.dispose();
      paint.geometry.dispose();
      hood.geometry.dispose();
      for (const m of materials) m.dispose();
      root.traverse((o) => {
        if (o.isMesh && (o.geometry.type === 'BoxGeometry' || o.geometry.type === 'TorusGeometry')) o.geometry.dispose();
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

let beamTexture = null;
/** Soft forward-fading pool of light for the beam decal. */
function getBeamTexture() {
  if (beamTexture) return beamTexture;
  // Elliptical falloff that reaches zero before every edge of the texture.
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s * 0.3, 0, s / 2, s * 0.42, s * 0.48);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.4)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  beamTexture = new THREE.CanvasTexture(c);
  beamTexture.colorSpace = THREE.SRGBColorSpace;
  return beamTexture;
}
