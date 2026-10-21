/**
 * Heading-up circular minimap. The whole city is rasterised once into an
 * offscreen canvas; each frame we draw a rotated window of it, then traffic
 * dots and the player arrow on top.
 */
const MAP_SCALE = 1.6;      // offscreen pixels per metre
const VIEW_RADIUS = 130;    // metres visible from centre to edge

export class Minimap {
  constructor(layout) {
    this.layout = layout;
    this.canvas = document.getElementById('minimap');
    this.ctx = this.canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.px = 200;
    this.canvas.width = this.px * dpr;
    this.canvas.height = this.px * dpr;
    this.ctx.scale(dpr, dpr);
    this.map = this._renderCity();
  }

  _renderCity() {
    const L = this.layout;
    const pad = 20;
    const w = (L.extentX + pad * 2) * MAP_SCALE;
    const h = (L.extentZ + pad * 2) * MAP_SCALE;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w);
    c.height = Math.ceil(h);
    const ctx = c.getContext('2d');
    this.origin = { x: -L.halfX - pad, z: -L.halfZ - pad };
    const tx = (x) => (x - this.origin.x) * MAP_SCALE;
    const tz = (z) => (z - this.origin.z) * MAP_SCALE;

    ctx.fillStyle = '#2f4a2a';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#4a4d55'; // asphalt
    ctx.fillRect(tx(-L.halfX), tz(-L.halfZ), L.extentX * MAP_SCALE, L.extentZ * MAP_SCALE);

    for (const b of L.blocks) {
      const s = b.size * MAP_SCALE;
      ctx.fillStyle = b.park ? '#3f7a3a' : '#8d8a84';
      ctx.fillRect(tx(b.cx - b.size / 2), tz(b.cz - b.size / 2), s, s);
    }
    ctx.fillStyle = '#c9c4ba';
    for (const b of L.buildings) {
      if (b.y > 0) continue; // towers on podiums share the footprint
      ctx.fillRect(tx(b.x - b.w / 2), tz(b.z - b.d / 2), b.w * MAP_SCALE, b.d * MAP_SCALE);
    }
    // Centre lines for readability.
    ctx.strokeStyle = 'rgba(242,194,58,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of L.roadX) {
      ctx.moveTo(tx(x), tz(-L.halfZ));
      ctx.lineTo(tx(x), tz(L.halfZ));
    }
    for (const z of L.roadZ) {
      ctx.moveTo(tx(-L.halfX), tz(z));
      ctx.lineTo(tx(L.halfX), tz(z));
    }
    ctx.stroke();
    return c;
  }

  /** player: {x, z, heading}; traffic: iterable of {x, z} */
  update(player, traffic) {
    const ctx = this.ctx;
    const s = this.px;
    const half = s / 2;
    const zoom = half / VIEW_RADIUS; // screen px per metre

    ctx.clearRect(0, 0, s, s);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1d2a1b';
    ctx.fillRect(0, 0, s, s);

    // World -> screen: centre on the player, rotate so heading points up.
    ctx.translate(half, half);
    ctx.rotate(player.heading - Math.PI);
    ctx.scale(zoom, zoom);
    ctx.translate(-(player.x - this.origin.x), -(player.z - this.origin.z));
    ctx.drawImage(this.map, 0, 0, this.map.width / MAP_SCALE, this.map.height / MAP_SCALE);

    ctx.fillStyle = '#4fc3f7';
    for (const t of traffic) {
      ctx.beginPath();
      ctx.arc(t.x - this.origin.x, t.z - this.origin.z, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Player arrow (always centred, pointing up).
    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = '#ff5a3c';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // North marker on the rim (world -Z is "north").
    // With the rotation above, world -z lands at screen direction (-sin h, cos h).
    const nr = half - 11;
    const nx = half - Math.sin(player.heading) * nr;
    const ny = half + Math.cos(player.heading) * nr;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(nx, ny, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
  }
}
