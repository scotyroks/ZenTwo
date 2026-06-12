// Spectral photon tracer.
//
// Physical model:
//  - Each photon samples a wavelength from a 6500 K Planck (blackbody)
//    spectrum via inverse-CDF, and carries a linear-sRGB tristimulus weight
//    derived from the CIE 1931 color matching functions (Wyman/Sloan/Shirley
//    piecewise-Gaussian fits, JCGT 2013), white-balanced so the full
//    spectrum integrates to neutral white.
//  - Glass is SCHOTT N-BK7: index of refraction from the Sellmeier equation,
//    so dispersion (rainbow separation) is physically correct.
//  - Glass interfaces use the exact unpolarized→polarized Fresnel equations.
//    In 2D the plane of incidence is the simulation plane itself, so s/p
//    polarization state is tracked exactly per photon and compounds
//    correctly across multiple interfaces (Brewster-angle behavior is real).
//  - Diffuse walls are Lambertian (cosine-weighted in 2D), albedo 0.85
//    (matte white paint). Mirrors reflect 92% (aluminum, averaged over the
//    visible band). Termination is Russian roulette — unbiased, no
//    energy-losing bounce cap (a 500-bounce safety cap remains; reaching it
//    has probability < 1e-18 for any physical albedo here).
//  - Rays are traced in the unbounded plane: light that leaves the viewport
//    keeps interacting with geometry and may re-enter; only the visible
//    portion of each path deposits.
//  - Deposition uses Amanatides–Woo grid traversal: each pixel receives
//    energy proportional to the exact path length crossing it, so brightness
//    has no direction-dependent rasterization bias.
//  - Display: per-channel film response 1 - exp(-k·E) (photon-counting
//    saturation), then the exact piecewise sRGB transfer function.

'use strict';

// --- Spectral tables ---------------------------------------------------------

const L_MIN = 380;            // nm
const L_MAX = 730;            // nm
const NL = L_MAX - L_MIN + 1; // 1 nm bins
const INV_N = 2048;           // inverse-CDF resolution

const RGB_R = new Float32Array(NL);   // linear-sRGB weight per wavelength
const RGB_G = new Float32Array(NL);
const RGB_B = new Float32Array(NL);
const N_GLASS = new Float32Array(NL); // BK7 refractive index per wavelength
const INV_CDF = new Uint16Array(INV_N); // u -> wavelength bin

(function buildSpectralTables() {
  // CIE 1931 2° CMF fits (Wyman, Sloan, Shirley 2013, multi-lobe Gaussians).
  function lobe(l, mu, t1, t2) {
    const t = (l < mu ? t1 : t2) * (l - mu);
    return Math.exp(-0.5 * t * t);
  }
  function cmfX(l) {
    return 0.362 * lobe(l, 442.0, 0.0624, 0.0374)
         + 1.056 * lobe(l, 599.8, 0.0264, 0.0323)
         - 0.065 * lobe(l, 501.1, 0.0490, 0.0382);
  }
  function cmfY(l) {
    return 0.821 * lobe(l, 568.8, 0.0213, 0.0247)
         + 0.286 * lobe(l, 530.9, 0.0613, 0.0322);
  }
  function cmfZ(l) {
    return 1.217 * lobe(l, 437.0, 0.0845, 0.0278)
         + 0.681 * lobe(l, 459.0, 0.0385, 0.0725);
  }

  // Emission spectrum: Planck's law at 6500 K (relative units).
  // c2 = h*c/kB = 1.4387768e7 nm·K
  const T = 6500;
  const C2 = 1.4387768e7;
  const spd = new Float64Array(NL);
  let spdSum = 0;
  for (let j = 0; j < NL; j++) {
    const l = L_MIN + j;
    spd[j] = 1 / (Math.pow(l, 5) * (Math.exp(C2 / (l * T)) - 1));
    spdSum += spd[j];
  }

  // Per-wavelength linear sRGB (IEC 61966-2-1 matrix, D65 primaries).
  // Out-of-gamut spectral colors keep their negative components; they are
  // accumulated as-is and only clamped at display time.
  let wr = 0, wg = 0, wb = 0;
  for (let j = 0; j < NL; j++) {
    const l = L_MIN + j;
    const X = cmfX(l), Y = cmfY(l), Z = cmfZ(l);
    const r =  3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    const b =  0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    RGB_R[j] = r; RGB_G[j] = g; RGB_B[j] = b;
    const p = spd[j] / spdSum;
    wr += r * p; wg += g * p; wb += b * p;
  }
  // White balance: the expected photon weight over the emission spectrum
  // becomes exactly (1,1,1), so undispersed light renders neutral.
  for (let j = 0; j < NL; j++) {
    RGB_R[j] /= wr; RGB_G[j] /= wg; RGB_B[j] /= wb;
  }

  // BK7 refractive index — SCHOTT N-BK7 Sellmeier coefficients (λ in µm).
  const B1 = 1.03961212,    B2 = 0.231792344,  B3 = 1.01046945;
  const C1 = 0.00600069867, Cc2 = 0.0200179144, C3 = 103.560653;
  for (let j = 0; j < NL; j++) {
    const um = (L_MIN + j) / 1000;
    const l2 = um * um;
    const n2 = 1 + B1 * l2 / (l2 - C1) + B2 * l2 / (l2 - Cc2) + B3 * l2 / (l2 - C3);
    N_GLASS[j] = Math.sqrt(n2);
  }

  // Inverse CDF for wavelength sampling (photons all carry equal power).
  const cdf = new Float64Array(NL);
  let c = 0;
  for (let j = 0; j < NL; j++) { c += spd[j] / spdSum; cdf[j] = c; }
  let j = 0;
  for (let k = 0; k < INV_N; k++) {
    const u = (k + 0.5) / INV_N;
    while (j < NL - 1 && cdf[j] < u) j++;
    INV_CDF[k] = j;
  }
})();

// --- Display transfer LUT ----------------------------------------------------

// byte = sRGB_encode(1 - exp(-u)) for u in [0, 16), step 1/512.
const TM_SCALE = 512;
const TM_N = 16 * TM_SCALE;
const TM_LUT = new Uint8Array(TM_N);
(function buildToneLut() {
  for (let i = 0; i < TM_N; i++) {
    const v = 1 - Math.exp(-i / TM_SCALE);
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    TM_LUT[i] = Math.round(255 * Math.min(1, Math.max(0, c)));
  }
})();

// --- Materials ---------------------------------------------------------------

const TYPE_DIFFUSE = 0;
const TYPE_MIRROR  = 1;
const TYPE_GLASS   = 2;

const ALBEDO_DIFFUSE = 0.85; // matte white paint
const REFL_MIRROR    = 0.92; // aluminum, visible-band average

const TWO_PI = Math.PI * 2;
const GOLDEN = 0.6180339887498949; // emission angles fill via golden-ratio LDS
const MAX_BOUNCES = 500;           // safety only; RR terminates paths
const EPS_T = 1e-4;

// --- State -------------------------------------------------------------------

let W = 0, H = 0;
let accum = null;        // Float32Array(W*H*3), linear-sRGB energy
let segments = [];
let light = null;
let raysTraced = 0;
let photonIndex = 0;
let phi0 = 0;
let exposure = 1;
let running = false;
let framePool = [];      // reusable RGBA ArrayBuffers (ping-pong with main)
let lastFrameTime = 0;

const FRAME_MS = 60;     // display refresh cadence
const TICK_MS = 14;      // trace-loop slice between message checks

// Zero-delay self-scheduling (setTimeout(0) gets clamped to 4ms when nested).
let tickScheduled = false;
const chan = new MessageChannel();
chan.port1.onmessage = () => { tickScheduled = false; tick(); };
function schedule() {
  if (!tickScheduled) { tickScheduled = true; chan.port2.postMessage(0); }
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      W = m.width; H = m.height;
      accum = new Float32Array(W * H * 3);
      framePool = [new ArrayBuffer(W * H * 4), new ArrayBuffer(W * H * 4)];
      resetAccum();
      break;
    case 'scene':
      segments = m.segments;
      light = m.light;
      resetAccum();
      break;
    case 'exposure':
      exposure = m.value;
      lastFrameTime = 0; // refresh display promptly
      break;
    case 'start':
      if (!running) { running = true; schedule(); }
      break;
    case 'stop':
      running = false;
      break;
    case 'ack':
      if (framePool.length < 2) {
        framePool.push(
          m.buffer && m.buffer.byteLength === W * H * 4
            ? m.buffer
            : new ArrayBuffer(W * H * 4)
        );
      }
      break;
  }
};

function resetAccum() {
  if (accum) accum.fill(0);
  raysTraced = 0;
  photonIndex = 0;
  phi0 = Math.random();
  lastFrameTime = 0;
}

function tick() {
  if (!running) return;
  if (accum && light) {
    const t0 = performance.now();
    do {
      for (let i = 0; i < 64; i++) traceRay();
      raysTraced += 64;
    } while (performance.now() - t0 < TICK_MS);
    maybeSendFrame();
  }
  schedule();
}

function maybeSendFrame() {
  const now = performance.now();
  if (now - lastFrameTime < FRAME_MS || framePool.length === 0) return;
  lastFrameTime = now;

  let buf = framePool.pop();
  if (buf.byteLength !== W * H * 4) buf = new ArrayBuffer(W * H * 4);
  const out = new Uint32Array(buf);

  // Normalize by rays traced so the image is stable while it converges.
  // Radial falloff from a point source is 1/r with r ∝ √(W·H) at equal
  // screen fraction, so √(W·H) scaling keeps brightness independent of
  // canvas resolution.
  const k = exposure * Math.sqrt(W * H) / Math.max(raysTraced, 1) * 1.25;
  const a = accum;
  const n = W * H;
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    let ur = a[o] * k, ug = a[o + 1] * k, ub = a[o + 2] * k;
    const r = TM_LUT[ur <= 0 ? 0 : ur >= 15.998 ? TM_N - 1 : (ur * TM_SCALE) | 0];
    const g = TM_LUT[ug <= 0 ? 0 : ug >= 15.998 ? TM_N - 1 : (ug * TM_SCALE) | 0];
    const b = TM_LUT[ub <= 0 ? 0 : ub >= 15.998 ? TM_N - 1 : (ub * TM_SCALE) | 0];
    out[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  self.postMessage(
    { type: 'frame', buffer: buf, rays: raysTraced, width: W, height: H },
    [buf]
  );
}

// --- Tracing -----------------------------------------------------------------

function traceRay() {
  // Wavelength: equal-power photons sampled from the source spectrum.
  const bin = INV_CDF[(Math.random() * INV_N) | 0];
  const pr = RGB_R[bin], pg = RGB_G[bin], pb = RGB_B[bin];
  const nGlass = N_GLASS[bin];

  // Emission: isotropic point source; golden-ratio sequence equidistributes
  // angles for faster convergence (rotated randomly per scene).
  const phi = TWO_PI * fract(phi0 + (photonIndex++) * GOLDEN);
  let x = light.x, y = light.y;
  let dx = Math.cos(phi), dy = Math.sin(phi);

  let inGlass = false;
  let ws = 0.5, wp = 0.5;  // s/p polarization power fractions (sum = 1)
  let lastSeg = -1;

  for (let bounce = 0; bounce < MAX_BOUNCES; bounce++) {
    let bestT = Infinity;
    let bestSeg = -1;
    for (let i = 0; i < segments.length; i++) {
      if (i === lastSeg) continue;
      const s = segments[i];
      const t = raySegmentT(x, y, dx, dy, s.x1, s.y1, s.x2, s.y2);
      if (t > EPS_T && t < bestT) { bestT = t; bestSeg = i; }
    }

    if (bestSeg < 0) {
      // Escapes to infinity; deposit() clips to the viewport.
      deposit(x, y, x + dx * 1e5, y + dy * 1e5, pr, pg, pb);
      return;
    }

    const hx = x + dx * bestT;
    const hy = y + dy * bestT;
    deposit(x, y, hx, hy, pr, pg, pb);

    const s = segments[bestSeg];
    const sdx = s.x2 - s.x1;
    const sdy = s.y2 - s.y1;
    const slen = Math.hypot(sdx, sdy) || 1;
    let nx = -sdy / slen;
    let ny =  sdx / slen;
    if (nx * dx + ny * dy > 0) { nx = -nx; ny = -ny; } // face the photon

    if (s.type === TYPE_DIFFUSE) {
      if (Math.random() >= ALBEDO_DIFFUSE) return; // absorbed (RR)
      ws = 0.5; wp = 0.5; // diffuse scattering depolarizes
      // 2D Lambertian: pdf ∝ cosθ  ⇒  θ = asin(2u-1)
      const theta = Math.asin(2 * Math.random() - 1);
      const cs = Math.cos(theta), sn = Math.sin(theta);
      dx = nx * cs - ny * sn;
      dy = ny * cs + nx * sn;
    } else if (s.type === TYPE_MIRROR) {
      if (Math.random() >= REFL_MIRROR) return; // absorbed (RR)
      const dn = dx * nx + dy * ny;
      dx -= 2 * dn * nx;
      dy -= 2 * dn * ny;
    } else {
      // Glass: exact dielectric Fresnel with polarization.
      const n1 = inGlass ? nGlass : 1;
      const n2 = inGlass ? 1 : nGlass;
      const eta = n1 / n2;
      const cosI = -(dx * nx + dy * ny);
      const sinT2 = eta * eta * (1 - cosI * cosI);
      if (sinT2 >= 1) {
        // Total internal reflection (R = 1 for both polarizations).
        const dn = dx * nx + dy * ny;
        dx -= 2 * dn * nx;
        dy -= 2 * dn * ny;
      } else {
        const cosT = Math.sqrt(1 - sinT2);
        const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
        const rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
        const Rs = rs * rs, Rp = rp * rp;
        const R = ws * Rs + wp * Rp;
        if (Math.random() < R) {
          const dn = dx * nx + dy * ny;
          dx -= 2 * dn * nx;
          dy -= 2 * dn * ny;
          ws = ws * Rs / R;
          wp = wp * Rp / R;
        } else {
          const T = 1 - R;
          dx = eta * dx + (eta * cosI - cosT) * nx;
          dy = eta * dy + (eta * cosI - cosT) * ny;
          ws = ws * (1 - Rs) / T;
          wp = wp * (1 - Rp) / T;
          inGlass = !inGlass;
        }
      }
    }

    const dl = Math.hypot(dx, dy) || 1; // guard against fp drift
    dx /= dl; dy /= dl;

    x = hx; y = hy;
    lastSeg = bestSeg;
  }
}

function fract(v) {
  return v - Math.floor(v);
}

function raySegmentT(px, py, dx, dy, ax, ay, bx, by) {
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

// Energy-exact deposition: Liang–Barsky clip to the viewport, then
// Amanatides–Woo traversal adding (exact length in pixel) × photon RGB.
function deposit(x0, y0, x1, y1, pr, pg, pb) {
  let dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return;
  dx /= len; dy /= len;

  let t0 = 0, t1 = len;
  if (dx !== 0) {
    const ta = (0 - x0) / dx, tb = (W - x0) / dx;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  } else if (x0 < 0 || x0 >= W) return;
  if (dy !== 0) {
    const ta = (0 - y0) / dy, tb = (H - y0) / dy;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
  } else if (y0 < 0 || y0 >= H) return;
  if (t0 >= t1) return;

  const sx = x0 + dx * t0;
  const sy = y0 + dy * t0;
  let ix = Math.floor(sx), iy = Math.floor(sy);
  if (ix < 0) ix = 0; else if (ix >= W) ix = W - 1;
  if (iy < 0) iy = 0; else if (iy >= H) iy = H - 1;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = Infinity, tMaxY = Infinity;
  if (dx > 0) tMaxX = (ix + 1 - sx) / dx;
  else if (dx < 0) tMaxX = (ix - sx) / dx;
  if (dy > 0) tMaxY = (iy + 1 - sy) / dy;
  else if (dy < 0) tMaxY = (iy - sy) / dy;

  const tEnd = t1 - t0;
  let t = 0;
  const a = accum;
  while (t < tEnd) {
    const tNext = Math.min(tMaxX, tMaxY, tEnd);
    const seg = tNext - t;
    if (seg > 0) {
      const o = (iy * W + ix) * 3;
      a[o] += pr * seg;
      a[o + 1] += pg * seg;
      a[o + 2] += pb * seg;
    }
    t = tNext;
    if (tMaxX <= tMaxY) { ix += stepX; tMaxX += tDeltaX; }
    else { iy += stepY; tMaxY += tDeltaY; }
    if (ix < 0 || ix >= W || iy < 0 || iy >= H) break;
  }
}
