import * as THREE from 'three';

const SWEEP = Math.PI * 1.5;          // 270 degrees of needle travel
const START = Math.PI * 0.75;         // needle rotation at zero (lower left)

/**
 * Cockpit dashboard: a sloped dash top, a cowl over the instrument cluster,
 * a speedometer and a rev counter (canvas-drawn backlit faces with real 3D
 * needles), indicator arrows and a centre-console screen. The cluster faces
 * the driver's eye. update() drives the needles and tell-tales.
 *
 * ck: the cockpit description (eye, wheel, dash positions); width: interior width.
 */
export function createDashboard(ck, width, maxKmh = 260) {
  const group = new THREE.Group();
  const plastic = new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.75 });
  const [ex, ey, ez] = ck.eye;
  const [wy, wz] = ck.wheel;

  // Dash top: a sloped slab across the car in front of the wheel.
  const top = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, 0.05, 0.55), plastic);
  top.position.set(0, wy + 0.16, wz + 0.32);
  top.rotation.x = 0.12;
  group.add(top);

  // Instrument cluster facing the eye.
  const cluster = new THREE.Group();
  cluster.position.set(ex, wy + 0.13, wz + 0.2);
  cluster.lookAt(ex, ey, ez);
  cluster.scale.setScalar(1.35);
  group.add(cluster);
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.03, 0.12), plastic);
  cowl.position.set(0, 0.095, 0.03);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.2), plastic);
  back.position.z = -0.005;
  cluster.add(cowl, back);

  const faceMat = (tex) => new THREE.MeshStandardMaterial({
    map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.4,
  });
  const needleMat = new THREE.MeshBasicMaterial({ color: 0xff3b2e });
  const needleGeo = new THREE.BoxGeometry(0.005, 0.062, 0.002).translate(0, 0.027, 0.004);
  const gauge = (x, tex) => {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.078, 40), faceMat(tex));
    face.position.set(x, 0, 0);
    const pivot = new THREE.Group();
    pivot.position.set(x, 0, 0.003);
    pivot.add(new THREE.Mesh(needleGeo, needleMat));
    const cap = new THREE.Mesh(new THREE.CircleGeometry(0.009, 12), plastic);
    cap.position.set(x, 0, 0.008);
    cluster.add(face, pivot, cap);
    return { face, pivot };
  };
  const speedo = gauge(-0.09, makeDial(maxKmh, 20, 'km/h', null));
  const tacho = gauge(0.09, makeDial(8, 1, 'x1000 rpm', 6.5));

  // Indicator arrows between the dials.
  const arrowMat = (on) => new THREE.MeshBasicMaterial({ color: on ? 0x3ddc84 : 0x0c2a16 });
  const arrowGeo = new THREE.ConeGeometry(0.012, 0.022, 3).rotateZ(Math.PI / 2);
  const indL = new THREE.Mesh(arrowGeo, arrowMat(false));
  const indR = new THREE.Mesh(arrowGeo.clone().rotateZ(Math.PI), arrowMat(false));
  indL.position.set(-0.015, 0.05, 0.004);
  indR.position.set(0.015, 0.05, 0.004);
  cluster.add(indL, indR);

  // Centre console screen.
  const screenTex = makeScreen();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.12), faceMat(screenTex));
  screen.position.set(0, wy + 0.06, wz + 0.26);
  screen.lookAt(ex * 0.3, ey, ez);
  group.add(screen);

  const offColor = new THREE.Color(0x0c2a16);
  const onColor = new THREE.Color(0x3ddc84);
  return {
    group,
    /** kmh, rpm01 (0..1 of the dial range), left / right indicator, night 0..1 */
    update(kmh, rpmK, left, right, night) {
      speedo.pivot.rotation.z = START - Math.min(kmh / maxKmh, 1) * SWEEP;
      tacho.pivot.rotation.z = START - Math.min(rpmK / 8, 1) * SWEEP;
      indL.material.color.copy(left ? onColor : offColor);
      indR.material.color.copy(right ? onColor : offColor);
      const glow = 0.35 + night * 0.6;
      speedo.face.material.emissiveIntensity = glow;
      tacho.face.material.emissiveIntensity = glow;
      screen.material.emissiveIntensity = glow;
    },
  };
}

/** Backlit dial: ticks every `step`, numbers, optional red zone from `redFrom`. */
function makeDial(max, step, label, redFrom) {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const r = s / 2;
  ctx.fillStyle = '#0b0d11';
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a4250';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Angle measured clockwise from 12 o'clock: -135 deg .. +135 deg.
  const at = (v) => -Math.PI * 0.75 + (v / max) * SWEEP;
  if (redFrom !== null) {
    ctx.strokeStyle = '#e0352a';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(r, r, r - 18, at(redFrom) - Math.PI / 2, at(max) - Math.PI / 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#e8edf3';
  ctx.strokeStyle = '#e8edf3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 24px system-ui, sans-serif';
  const minor = step / 2;
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = at(v);
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const r0 = r - (major ? 34 : 24);
    ctx.lineWidth = major ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(r + Math.sin(a) * r0, r - Math.cos(a) * r0);
    ctx.lineTo(r + Math.sin(a) * (r - 12), r - Math.cos(a) * (r - 12));
    ctx.stroke();
    if (major && (step >= 1 ? true : v % 1 === 0)) {
      ctx.fillText(String(Math.round(v)), r + Math.sin(a) * (r - 56), r - Math.cos(a) * (r - 56));
    }
  }
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillStyle = '#8a95a5';
  ctx.fillText(label, r, r + 62);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeScreen() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 154;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 154);
  g.addColorStop(0, '#10233a');
  g.addColorStop(1, '#081220');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 154);
  // A little navigation map.
  ctx.strokeStyle = '#2f5d86';
  ctx.lineWidth = 6;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 60 + 10, 0);
    ctx.lineTo(i * 60 - 20, 154);
    ctx.moveTo(0, i * 40 + 12);
    ctx.lineTo(256, i * 40 + 2);
    ctx.stroke();
  }
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(128, 140);
  ctx.lineTo(118, 92);
  ctx.lineTo(176, 52);
  ctx.stroke();
  ctx.fillStyle = '#ff5a3c';
  ctx.beginPath();
  ctx.moveTo(128, 120);
  ctx.lineTo(120, 136);
  ctx.lineTo(136, 136);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
