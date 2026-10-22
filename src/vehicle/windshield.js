import * as THREE from 'three';

const SWEEP = 1.35;   // wiper half-angle (radians from straight up)

/**
 * Cockpit-view windshield: rain drops on the glass and two wipers.
 *
 * Drops are procedural (a grid of cells, each with its own random drop).
 * For every pixel the shader works out when the wiper last passed over it
 * (the wiper angle is a triangle wave in time, so the crossings are
 * analytic): a drop only shows once enough time has passed since that wipe,
 * so drops vanish under the blade and build up again behind it.
 *
 * spec: the procedural cockpit description (A-pillar base / top points).
 */
export function createWindshield(spec) {
  const group = new THREE.Group();
  const [bx, by, bz] = spec.pillarBase;
  const [tx, ty, tz] = spec.pillarTop;
  // Slightly inside the glass, toward the driver.
  const inset = -0.02;
  const bl = new THREE.Vector3(bx, by, bz + inset);
  const br = new THREE.Vector3(-bx, by, bz + inset);
  const tl = new THREE.Vector3(tx, ty, tz + inset);
  const tr = new THREE.Vector3(-tx, ty, tz + inset);
  // u runs across (driver's left -> right), v up the glass.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...bl.toArray(), ...br.toArray(), ...tr.toArray(), ...tl.toArray()], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const uniforms = { uTime: { value: 0 }, uRain: { value: 0 }, uPeriod: { value: 0.8 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uRain;
      uniform float uPeriod;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        if (uRain < 0.01) discard;
        // Time since the wiper last crossed this pixel.
        vec2 p = (vUv - vec2(0.5, -0.08)) * vec2(1.6, 1.0);
        float ang = atan(p.x, p.y);
        float s = clamp((ang + ${SWEEP.toFixed(2)}) / ${(SWEEP * 2).toFixed(2)}, 0.0, 1.0);
        float tau = uTime / uPeriod;
        float c1 = 2.0 * floor((tau - s) / 2.0) + s;
        float c2 = 2.0 * floor((tau - (2.0 - s)) / 2.0) + (2.0 - s);
        float since = (tau - max(c1, c2)) * uPeriod;
        since = mix(1000.0, since, step(length(p), 1.08));
        // One possible drop per cell, appearing some time after the wipe.
        vec2 grid = vUv * vec2(36.0, 22.0);
        vec2 id = floor(grid);
        vec2 f = fract(grid) - 0.5;
        float h = hash(id);
        vec2 off = vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5;
        float r = 0.14 + 0.24 * hash(id + 1.3);
        float vis = step(h * 2.2 / max(uRain, 0.05), since) * step(0.3, hash(id + 9.1));
        float d = length((f - off * 0.5) * vec2(1.0, 1.35)) / r;
        float drop = (1.0 - smoothstep(0.75, 1.0, d)) * vis;
        float rim = smoothstep(0.45, 1.0, d) * drop;
        vec3 col = mix(vec3(0.05, 0.06, 0.07), vec3(0.85, 0.9, 1.0), rim);
        gl_FragColor = vec4(col, drop * (0.22 + rim * 0.45) * uRain);
      }`,
  });
  const glass = new THREE.Mesh(geo, mat);
  glass.renderOrder = 10;
  group.add(glass);

  // Wipers: a frame on the glass (x along u, y up the glass), two blades.
  const U = br.clone().sub(bl).normalize();
  const bottomMid = bl.clone().add(br).multiplyScalar(0.5);
  const topMid = tl.clone().add(tr).multiplyScalar(0.5);
  const V = topMid.clone().sub(bottomMid).normalize();
  const N = U.clone().cross(V).normalize();
  const frame = new THREE.Group();
  frame.matrixAutoUpdate = false;
  frame.matrix.makeBasis(U, V, N).setPosition(bottomMid.clone().addScaledVector(N, 0.01));
  group.add(frame);
  const width = bl.distanceTo(br);
  const height = bottomMid.distanceTo(topMid);
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.7 });
  const bladeGeo = new THREE.BoxGeometry(0.025, height * 0.62, 0.02).translate(0, height * 0.31, 0);
  const blades = [-0.2, 0.22].map((u) => {
    const pivot = new THREE.Group();
    pivot.position.set(u * width, 0.02, 0);
    pivot.add(new THREE.Mesh(bladeGeo, bladeMat));
    frame.add(pivot);
    return pivot;
  });

  let parked = true;
  return {
    group,
    /** dt, rain 0..1 */
    update(dt, rain) {
      uniforms.uRain.value = rain;
      const wiping = rain > 0.05;
      if (wiping || !parked) uniforms.uTime.value += dt;
      // Triangle wave 0..1 (one-way sweep per period); parks at the start.
      const tau = uniforms.uTime.value / uniforms.uPeriod.value;
      let w = 1 - Math.abs((tau % 2) - 1);
      if (!wiping) {
        if (w < 0.03 && Math.floor(tau) % 2 === 0) parked = true;
      } else {
        parked = false;
      }
      if (parked) w = 0;
      const ang = -SWEEP + w * SWEEP * 2;
      for (const b of blades) b.rotation.z = -ang;
    },
  };
}
