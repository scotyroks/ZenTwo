// Raytracing worker — traces photons and writes into a Float32 accumulator.

let W = 0, H = 0;
let accum = null;        // Float32Array(W*H), per-pixel photon hit count
let segments = [];       // [{x1,y1,x2,y2,type}]  type: 0 diffuse, 1 mirror, 2 glass
let light = null;        // {x,y}
let raysTraced = 0;
let running = false;
let pendingAck = false;

const TWO_PI = Math.PI * 2;
const MAX_BOUNCES = 24;
const GLASS_IOR = 1.5;

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      W = m.width; H = m.height;
      accum = new Float32Array(W * H);
      raysTraced = 0;
      break;
    case 'scene':
      segments = m.segments;
      light = m.light;
      accum.fill(0);
      raysTraced = 0;
      pendingAck = false;
      if (running) scheduleLoop();
      break;
    case 'start':
      if (!running) {
        running = true;
        scheduleLoop();
      }
      break;
    case 'stop':
      running = false;
      break;
    case 'ack':
      pendingAck = false;
      if (running) scheduleLoop();
      break;
  }
};

function scheduleLoop() {
  if (!running || pendingAck) return;
  setTimeout(loop, 0);
}

function loop() {
  if (!running || !accum || !light) return;
  const start = performance.now();
  let traced = 0;
  // Trace for ~16ms or until 20k rays, whichever first.
  while (performance.now() - start < 16 && traced < 20000) {
    traceRay();
    traced++;
  }
  raysTraced += traced;
  // Send a copy of the accumulator back to main thread.
  const copy = new Float32Array(accum);
  pendingAck = true;
  self.postMessage(
    { type: 'frame', buffer: copy.buffer, rays: raysTraced },
    [copy.buffer]
  );
}

function traceRay() {
  let x = light.x;
  let y = light.y;
  const a = Math.random() * TWO_PI;
  let dx = Math.cos(a);
  let dy = Math.sin(a);
  let lastSeg = -1;

  for (let bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    // Find nearest segment intersection.
    let bestT = Infinity;
    let bestSeg = -1;
    for (let i = 0; i < segments.length; i++) {
      if (i === lastSeg) continue;
      const s = segments[i];
      const t = raySegmentT(x, y, dx, dy, s.x1, s.y1, s.x2, s.y2);
      if (t > 1e-4 && t < bestT) {
        bestT = t;
        bestSeg = i;
      }
    }
    // Clip to image bounds.
    const tEdge = rayBoxT(x, y, dx, dy);
    if (tEdge < bestT) {
      drawLine(x, y, x + dx * tEdge, y + dy * tEdge);
      return;
    }
    if (bestSeg < 0) {
      drawLine(x, y, x + dx * bestT, y + dy * bestT);
      return;
    }
    const hx = x + dx * bestT;
    const hy = y + dy * bestT;
    drawLine(x, y, hx, hy);

    const s = segments[bestSeg];
    const sdx = s.x2 - s.x1;
    const sdy = s.y2 - s.y1;
    const slen = Math.hypot(sdx, sdy) || 1;
    let nx = -sdy / slen;
    let ny =  sdx / slen;
    // Make normal face the incoming ray.
    if (nx * dx + ny * dy > 0) { nx = -nx; ny = -ny; }

    if (s.type === 0) {
      // Diffuse — cosine-weighted random direction in the hemisphere.
      const u = Math.random() * 2 - 1;
      const theta = Math.asin(u);
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      // Tangent along surface.
      const tx = -ny;
      const ty =  nx;
      dx = nx * cs + tx * sn;
      dy = ny * cs + ty * sn;
    } else if (s.type === 1) {
      // Mirror — perfect reflection.
      const dn = dx * nx + dy * ny;
      dx = dx - 2 * dn * nx;
      dy = dy - 2 * dn * ny;
    } else {
      // Glass — Snell refraction. Randomly choose entering/exiting since
      // we don't track inside/outside in 2D line geometry.
      const enter = Math.random() < 0.5;
      const eta = enter ? 1 / GLASS_IOR : GLASS_IOR;
      const cosI = -(dx * nx + dy * ny);
      const sinT2 = eta * eta * (1 - cosI * cosI);
      if (sinT2 >= 1) {
        // Total internal reflection.
        const dn = dx * nx + dy * ny;
        dx = dx - 2 * dn * nx;
        dy = dy - 2 * dn * ny;
      } else {
        const cosT = Math.sqrt(1 - sinT2);
        dx = eta * dx + (eta * cosI - cosT) * nx;
        dy = eta * dy + (eta * cosI - cosT) * ny;
      }
    }

    // Renormalize (drift insurance).
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;

    x = hx; y = hy;
    lastSeg = bestSeg;
  }
}

function raySegmentT(px, py, dx, dy, ax, ay, bx, by) {
  // Solve P + t*D = A + u*(B-A), return t if 0<=u<=1 and t>0, else Infinity.
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (denom === 0) return Infinity;
  const wx = ax - px;
  const wy = ay - py;
  const t = (wx * ey - wy * ex) / denom;
  if (t <= 0) return Infinity;
  const u = (wx * dy - wy * dx) / denom;
  if (u < 0 || u > 1) return Infinity;
  return t;
}

function rayBoxT(px, py, dx, dy) {
  let t = Infinity;
  if (dx > 0)      t = Math.min(t, (W - 1 - px) / dx);
  else if (dx < 0) t = Math.min(t, (0 - px) / dx);
  if (dy > 0)      t = Math.min(t, (H - 1 - py) / dy);
  else if (dy < 0) t = Math.min(t, (0 - py) / dy);
  return Math.max(t, 0);
}

function drawLine(x0, y0, x1, y1) {
  // Additive deposit along the segment using uniform 1-pixel stepping.
  const dx = x1 - x0;
  const dy = y1 - y0;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const steps = Math.max(adx, ady) | 0;
  if (steps === 0) return;
  const sx = dx / steps;
  const sy = dy / steps;
  let x = x0;
  let y = y0;
  for (let i = 0; i <= steps; i++) {
    const ix = x | 0;
    const iy = y | 0;
    if (ix >= 0 && ix < W && iy >= 0 && iy < H) {
      accum[iy * W + ix] += 1;
    }
    x += sx;
    y += sy;
  }
}
