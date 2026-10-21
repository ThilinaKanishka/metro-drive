/**
 * Car collision: the car is approximated by three circles along its length,
 * tested against axis-aligned boxes (buildings, walls) and circles (trees,
 * poles, other cars). Penetration is resolved by pushing the car out and
 * reflecting the velocity (see CarPhysics.applyImpact).
 */
export const CAR_CIRCLES = [
  { forward: 1.38, radius: 0.93 },
  { forward: 0, radius: 0.95 },
  { forward: -1.38, radius: 0.93 },
];

/** World-space centres of a car's collision circles. */
export function carCircles(x, z, heading, out = []) {
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  for (let i = 0; i < CAR_CIRCLES.length; i++) {
    const cc = CAR_CIRCLES[i];
    const o = (out[i] ||= { x: 0, z: 0, r: 0, forward: 0 });
    o.x = x + s * cc.forward;
    o.z = z + c * cc.forward;
    o.r = cc.radius;
    o.forward = cc.forward;
  }
  out.length = CAR_CIRCLES.length;
  return out;
}

const tmpCircles = [];

/**
 * Resolve collisions of the physics body against static colliders plus a list
 * of dynamic circles ({x, z, r, owner}). Returns the strongest impact speed
 * (m/s) and the owner of a hit dynamic body, if any.
 */
export function resolveCar(phys, staticColliders, dynamicCircles) {
  let impact = 0;
  let hitOwner = null;

  // Two passes handle corners where two boxes meet.
  for (let pass = 0; pass < 2; pass++) {
    const circles = carCircles(phys.x, phys.z, phys.heading, tmpCircles);
    for (const cc of circles) {
      for (const col of staticColliders) {
        const hit = col.type === 'box' ? circleBox(cc, col) : circleCircle(cc, col.x, col.z, col.r);
        if (hit) {
          impact = Math.max(impact, phys.applyImpact(hit.nx, hit.nz, hit.depth, cc.forward, 0));
          // Keep circle centres in sync after the push-out.
          cc.x += hit.nx * hit.depth;
          cc.z += hit.nz * hit.depth;
        }
      }
      for (const d of dynamicCircles) {
        const hit = circleCircle(cc, d.x, d.z, d.r);
        if (hit) {
          const v = phys.applyImpact(hit.nx, hit.nz, hit.depth, cc.forward, 0);
          if (v > impact) impact = v;
          hitOwner = d.owner;
          cc.x += hit.nx * hit.depth;
          cc.z += hit.nz * hit.depth;
        }
      }
    }
  }
  return { impact, hitOwner };
}

const hitResult = { nx: 0, nz: 0, depth: 0 };

function circleBox(c, b) {
  const qx = c.x < b.minX ? b.minX : c.x > b.maxX ? b.maxX : c.x;
  const qz = c.z < b.minZ ? b.minZ : c.z > b.maxZ ? b.maxZ : c.z;
  const dx = c.x - qx;
  const dz = c.z - qz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= c.r * c.r) return null;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    hitResult.nx = dx / d;
    hitResult.nz = dz / d;
    hitResult.depth = c.r - d;
    return hitResult;
  }
  // Centre inside the box: push out along the shallowest axis.
  const left = c.x - b.minX;
  const right = b.maxX - c.x;
  const top = c.z - b.minZ;
  const bottom = b.maxZ - c.z;
  const min = Math.min(left, right, top, bottom);
  hitResult.nx = min === left ? -1 : min === right ? 1 : 0;
  hitResult.nz = min === top ? -1 : min === bottom ? 1 : 0;
  if (hitResult.nx !== 0) hitResult.nz = 0;
  hitResult.depth = min + c.r;
  return hitResult;
}

function circleCircle(c, x, z, r) {
  const dx = c.x - x;
  const dz = c.z - z;
  const rr = c.r + r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr || d2 < 1e-10) return null;
  const d = Math.sqrt(d2);
  hitResult.nx = dx / d;
  hitResult.nz = dz / d;
  hitResult.depth = rr - d;
  return hitResult;
}
