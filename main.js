// Main thread: UI and scene editing only. All tracing and tone mapping
// happens in the worker; rendered RGBA frames arrive via transferable
// buffers that are ping-ponged back after putImageData (zero steady-state
// allocation).
//
// Scene model: a flat list of primitives (line segments and circular arcs),
// each with a material and a group id. Shape tools (box, circle, lens)
// emit several primitives sharing a group, so Move and Erase treat them
// as one object. Freehand lines get singleton groups.

const TYPE_DIFFUSE = 0;
const TYPE_MIRROR  = 1;
const TYPE_GLASS   = 2;

const COLORS = {
  [TYPE_DIFFUSE]: '#ffffff',
  [TYPE_MIRROR]:  '#6cf2ff',
  [TYPE_GLASS]:   '#ffd76a',
};

const view    = document.getElementById('view');
const overlay = document.getElementById('overlay');
const vctx = view.getContext('2d');
const octx = overlay.getContext('2d');

const modeButtons = document.querySelectorAll('[data-mode]');
const matButtons  = document.querySelectorAll('[data-mat]');
const expSlider = document.getElementById('exposure');
const raysEl = document.getElementById('rays');
const rpsEl  = document.getElementById('rps');
const hintEl = document.getElementById('hint');

let W = 0, H = 0;

// Scene state.
let light = null;                // {x,y}
let prims = [];                  // seg: {kind:'seg',type,group,x1,y1,x2,y2}
                                 // arc: {kind:'arc',type,group,cx,cy,r,a0,span}
let nextGroup = 1;
let undoStack = [];
let redoStack = [];

let mode = 'light';              // light|move|line|arc|circle|box|lens|erase
let material = TYPE_DIFFUSE;

// Interaction state.
let gesture = null;              // {x1,y1,x2,y2} for line/box/circle/lens drags
let arcState = null;             // {ax,ay,bx,by,stage:1|2,px,py}
let moving = null;               // {lightOnly, group, startX,startY, snap, moved}
let draggingLight = false;       // light tool drag
let erasing = false;
let eraseSnapshot = null;

let raysTraced = 0;
let lastRays = 0;
let lastRpsTime = performance.now();

const PREVIEW_MS = 80;           // live-render throttle while dragging
let lastSceneSend = 0;

const worker = new Worker('worker.js');
worker.onmessage = onWorkerMessage;
worker.onerror = (e) => {
  hintEl.textContent = 'Renderer failed to start — serve over HTTP (not file://). ' + (e.message || '');
  hintEl.classList.remove('hide');
};

// Capture before initCanvas: resize() → resendScene() → updateHash()
// rewrites location.hash, which would destroy an incoming shared link.
const initialHash = location.hash;
initCanvas();
if (!loadSceneFromHash(initialHash)) seedDefaultScene();
bindUI();
resendScene();

// Loading a pasted link into a running app (replaceState doesn't fire this).
window.addEventListener('hashchange', () => {
  if (loadSceneFromHash(location.hash)) {
    drawOverlay();
    resendScene();
  }
});

// --- Init / resize ----------------------------------------------------------

function initCanvas() {
  resize();
  let raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(resize);
  });
  // Pause tracing in hidden tabs (saves battery; accumulation resumes).
  document.addEventListener('visibilitychange', () => {
    worker.postMessage({ type: document.hidden ? 'stop' : 'start' });
  });
}

function resize() {
  const oldW = W, oldH = H;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  // Cap total pixel count for performance (~750k, ~9MB accumulator).
  const budget = 750000;
  const scale = Math.min(1, Math.sqrt(budget / (cssW * cssH)));
  W = Math.max(64, Math.floor(cssW * scale));
  H = Math.max(64, Math.floor(cssH * scale));
  view.width = W;
  view.height = H;
  overlay.width = W;
  overlay.height = H;

  if (!light) light = { x: W / 2, y: H / 2 };
  else if (oldW > 0 && (oldW !== W || oldH !== H)) {
    rescaleScene(W / oldW, H / oldH);
  }

  worker.postMessage({ type: 'init', width: W, height: H });
  worker.postMessage({ type: 'exposure', value: Math.pow(2, parseFloat(expSlider.value)) });
  resendScene();
  drawOverlay();
  worker.postMessage({ type: 'start' });
}

// Keep the composition proportional when the window changes size.
// Arcs stay circular: centers scale per-axis, radii by the geometric mean.
function rescaleScene(fx, fy) {
  const fr = Math.sqrt(fx * fy);
  const scalePrim = (p) => {
    if (p.kind === 'seg') {
      p.x1 *= fx; p.y1 *= fy; p.x2 *= fx; p.y2 *= fy;
    } else {
      p.cx *= fx; p.cy *= fy; p.r *= fr;
    }
  };
  light.x *= fx; light.y *= fy;
  prims.forEach(scalePrim);
  for (const snap of undoStack.concat(redoStack)) {
    snap.light.x *= fx; snap.light.y *= fy;
    snap.prims.forEach(scalePrim);
  }
}

// --- Geometry helpers ---------------------------------------------------------

function seg(type, group, x1, y1, x2, y2) {
  return { kind: 'seg', type, group, x1, y1, x2, y2 };
}

// Circumcircle through three points; null when (nearly) collinear.
function circle3(ax, ay, bx, by, px, py) {
  const d = 2 * (ax * (by - py) + bx * (py - ay) + px * (ay - by));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const p2 = px * px + py * py;
  const cx = (a2 * (by - py) + b2 * (py - ay) + p2 * (ay - by)) / d;
  const cy = (a2 * (px - bx) + b2 * (ax - px) + p2 * (bx - ax)) / d;
  return { cx, cy, r: Math.hypot(ax - cx, ay - cy) };
}

function ccwDist(a, b) {
  let d = b - a;
  d -= Math.floor(d / (2 * Math.PI)) * 2 * Math.PI;
  return d;
}

// Arc from A to B passing through P (the bulge point).
function arcFrom3(ax, ay, bx, by, px, py, type, group) {
  const c = circle3(ax, ay, bx, by, px, py);
  if (!c || c.r > 50000) {
    return seg(type, group, ax, ay, bx, by); // effectively straight
  }
  const angA = Math.atan2(ay - c.cy, ax - c.cx);
  const angB = Math.atan2(by - c.cy, bx - c.cx);
  const angP = Math.atan2(py - c.cy, px - c.cx);
  let a0, span;
  if (ccwDist(angA, angP) <= ccwDist(angA, angB)) {
    a0 = angA; span = ccwDist(angA, angB);
  } else {
    a0 = angB; span = ccwDist(angB, angA);
  }
  return { kind: 'arc', type, group, cx: c.cx, cy: c.cy, r: c.r, a0, span };
}

// Biconvex lens on chord A→B: two arcs bulging to either side.
const LENS_SAGITTA = 0.22; // sagitta as a fraction of the chord length
function makeLens(ax, ay, bx, by, type, group) {
  const len = Math.hypot(bx - ax, by - ay);
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const ux = -(by - ay) / len, uy = (bx - ax) / len;
  const s = LENS_SAGITTA * len;
  return [
    arcFrom3(ax, ay, bx, by, mx + ux * s, my + uy * s, type, group),
    arcFrom3(ax, ay, bx, by, mx - ux * s, my - uy * s, type, group),
  ];
}

// Primitives produced by the current in-progress gesture (for live preview
// and for committing on pointerup).
function gesturePrims() {
  if (arcState) {
    if (arcState.stage === 1) {
      return [seg(material, 0, arcState.ax, arcState.ay, arcState.bx, arcState.by)];
    }
    return [arcFrom3(arcState.ax, arcState.ay, arcState.bx, arcState.by,
                     arcState.px, arcState.py, material, 0)];
  }
  if (!gesture) return [];
  const { x1, y1, x2, y2 } = gesture;
  const w = x2 - x1, h = y2 - y1;
  const len = Math.hypot(w, h);
  switch (mode) {
    case 'line':
      return len >= 2 ? [seg(material, 0, x1, y1, x2, y2)] : [];
    case 'box':
      if (Math.abs(w) < 3 || Math.abs(h) < 3) return [];
      return [
        seg(material, 0, x1, y1, x2, y1),
        seg(material, 0, x2, y1, x2, y2),
        seg(material, 0, x2, y2, x1, y2),
        seg(material, 0, x1, y2, x1, y1),
      ];
    case 'circle':
      if (len < 3) return [];
      return [{ kind: 'arc', type: material, group: 0,
                cx: x1, cy: y1, r: len, a0: 0, span: 2 * Math.PI }];
    case 'lens':
      return len >= 8 ? makeLens(x1, y1, x2, y2, material, 0) : [];
  }
  return [];
}

function commitPrims(list) {
  if (!list.length) return;
  pushHistory();
  const g = nextGroup++;
  for (const p of list) prims.push({ ...p, group: g });
  dismissHint();
  drawOverlay();
  resendScene();
}

// --- Default scene ----------------------------------------------------------

function seedDefaultScene() {
  // Newton's experiment: a slit collimates the point source into a beam
  // before the prism — an omnidirectional source alone re-mixes the
  // per-angle rainbows back to white, so the slit is what makes the
  // dispersion fan visible. The fan lands on diffuse walls to the right.
  const G = TYPE_GLASS, D = TYPE_DIFFUSE;
  const cy = H * 0.5;
  const gap = Math.max(3, 0.008 * Math.min(W, H));
  const p = 0.16 * Math.min(W, H);          // prism half-base
  const px = W * 0.5, py = H * 0.50;        // prism center
  light = { x: W * 0.12, y: cy };
  prims = [
    seg(D, 1, W * 0.32, -0.1 * H, W * 0.32, cy - gap),
    seg(D, 2, W * 0.32, cy + gap, W * 0.32, 1.1 * H),
    seg(G, 3, px,     py - 0.95 * p, px - p, py + 0.78 * p),
    seg(G, 3, px - p, py + 0.78 * p, px + p, py + 0.78 * p),
    seg(G, 3, px + p, py + 0.78 * p, px,     py - 0.95 * p),
    seg(D, 4, W * 0.25, H * 0.92, W * 0.97, H * 0.92),
    seg(D, 5, W * 0.90, H * 0.20, W * 0.90, H * 0.92),
  ];
  nextGroup = 6;
  undoStack = [];
  redoStack = [];
}

// --- Shareable URLs ----------------------------------------------------------

// Scene → compact hash with resolution-independent coordinates:
//   v2 items:  "s,mat,group,x1,y1,x2,y2" | "a,mat,group,cx,cy,r,a0,span"
//   v1 items (legacy links): "mat,x1,y1,x2,y2"
// joined by ';', then "|lx,ly". Radii normalize by √(W·H).
function serializeScene() {
  const r = (v) => Math.round(v * 10000) / 10000;
  const S = Math.sqrt(W * H);
  const items = prims.map((p) => p.kind === 'seg'
    ? ['s', p.type, p.group, r(p.x1 / W), r(p.y1 / H), r(p.x2 / W), r(p.y2 / H)].join(',')
    : ['a', p.type, p.group, r(p.cx / W), r(p.cy / H), r(p.r / S), r(p.a0), r(p.span)].join(','))
    .join(';');
  return items + '|' + r(light.x / W) + ',' + r(light.y / H);
}

function parseScene(str) {
  const [itemPart, lightPart] = str.split('|');
  if (lightPart === undefined) return null;
  const lp = lightPart.split(',').map(Number);
  if (lp.length !== 2 || !lp.every(Number.isFinite)) return null;
  const S = Math.sqrt(W * H);
  const out = [];
  let maxGroup = 0;
  let autoGroup = 1000000; // singleton groups for legacy v1 items
  if (itemPart !== '') {
    for (const chunk of itemPart.split(';')) {
      const f = chunk.split(',');
      let prim;
      if (f[0] === 's' || f[0] === 'a') {
        const v = f.slice(1).map(Number);
        if (!v.every(Number.isFinite)) return null;
        const type = v[0] | 0, group = v[1] | 0;
        if (type < 0 || type > 2 || group < 0) return null;
        if (f[0] === 's') {
          if (v.length !== 6) return null;
          prim = seg(type, group, v[2] * W, v[3] * H, v[4] * W, v[5] * H);
        } else {
          if (v.length !== 7) return null;
          if (v[4] <= 0 || v[6] <= 0) return null;
          prim = { kind: 'arc', type, group, cx: v[2] * W, cy: v[3] * H,
                   r: v[4] * S, a0: v[5], span: Math.min(v[6], 2 * Math.PI) };
        }
        maxGroup = Math.max(maxGroup, group);
      } else {
        const v = f.map(Number);
        if (v.length !== 5 || !v.every(Number.isFinite)) return null;
        const type = v[0] | 0;
        if (type < 0 || type > 2) return null;
        prim = seg(type, autoGroup++, v[1] * W, v[2] * H, v[3] * W, v[4] * H);
        maxGroup = Math.max(maxGroup, prim.group);
      }
      out.push(prim);
      if (out.length > 2000) return null;
    }
  }
  return {
    light: { x: lp[0] * W, y: lp[1] * H },
    prims: out,
    nextGroup: maxGroup + 1,
  };
}

function loadSceneFromHash(hash) {
  const m = hash.match(/^#s=(.+)$/);
  if (!m) return false;
  try {
    const scene = parseScene(decodeURIComponent(m[1]));
    if (!scene) return false;
    light = scene.light;
    prims = scene.prims;
    nextGroup = scene.nextGroup;
    undoStack = [];
    redoStack = [];
    return true;
  } catch {
    return false;
  }
}

function updateHash() {
  // replaceState avoids polluting browser history on every edit.
  window.history.replaceState(null, '', '#s=' + serializeScene());
}

// --- Worker bridge ----------------------------------------------------------

function resendScene(throttled) {
  if (!light) return;
  const now = performance.now();
  if (throttled && now - lastSceneSend < PREVIEW_MS) return;
  lastSceneSend = now;
  const all = prims.concat(gesturePrims());
  const segs = [], arcList = [];
  for (const p of all) {
    if (p.kind === 'seg') {
      segs.push({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, type: p.type });
    } else {
      arcList.push({ cx: p.cx, cy: p.cy, r: p.r, a0: p.a0, span: p.span, type: p.type });
    }
  }
  worker.postMessage({
    type: 'scene',
    segments: segs,
    arcs: arcList,
    light: { x: light.x, y: light.y },
  });
  raysTraced = 0;
  lastRays = 0;
  if (!throttled && !gesture && !arcState) updateHash();
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type !== 'frame') return;
  const img = new ImageData(new Uint8ClampedArray(m.buffer), m.width, m.height);
  vctx.putImageData(img, 0, 0);
  raysTraced = m.rays;
  updateStats();
  // Return the buffer to the worker's pool.
  worker.postMessage({ type: 'ack', buffer: m.buffer }, [m.buffer]);
}

function updateStats() {
  const now = performance.now();
  const dt = now - lastRpsTime;
  if (dt > 500) {
    const rps = (raysTraced - lastRays) * 1000 / dt;
    lastRays = raysTraced;
    lastRpsTime = now;
    if (rps >= 0) rpsEl.textContent = formatNumber(rps) + ' rays/s';
  }
  raysEl.textContent = formatNumber(raysTraced) + ' rays';
}

function formatNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return Math.round(n).toString();
}

// --- Overlay (geometry outlines + light marker) -----------------------------

function strokePrim(p, color, width) {
  octx.strokeStyle = color;
  octx.lineWidth = width;
  octx.beginPath();
  if (p.kind === 'seg') {
    octx.moveTo(p.x1, p.y1);
    octx.lineTo(p.x2, p.y2);
  } else {
    octx.arc(p.cx, p.cy, p.r, p.a0, p.a0 + p.span);
  }
  octx.stroke();
}

function drawOverlay() {
  octx.clearRect(0, 0, W, H);

  const movingGroup = moving && !moving.lightOnly ? moving.group : -1;
  for (const p of prims) {
    const active = p.group === movingGroup;
    strokePrim(p, withAlpha(COLORS[p.type], active ? 0.9 : 0.45), active ? 1.5 : 1);
  }
  for (const p of gesturePrims()) {
    strokePrim(p, COLORS[p.type], 1.5);
  }

  if (light) {
    octx.fillStyle = '#ffd76a';
    octx.beginPath();
    octx.arc(light.x, light.y, 5, 0, Math.PI * 2);
    octx.fill();
    octx.strokeStyle = 'rgba(0,0,0,0.6)';
    octx.lineWidth = 1;
    octx.stroke();
  }
}

function withAlpha(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// --- Input handling ---------------------------------------------------------

const MODE_KEYS = {
  '1': 'light',  l: 'light',
  '2': 'move',   v: 'move',
  '3': 'line',   w: 'line',
  '4': 'arc',    a: 'arc',
  '5': 'circle', c: 'circle',
  '6': 'box',    r: 'box',
  '7': 'lens',   f: 'lens',
  '8': 'erase',  e: 'erase',
};
const MAT_KEYS = { d: TYPE_DIFFUSE, m: TYPE_MIRROR, g: TYPE_GLASS };

function selectMode(name) {
  cancelInteraction();
  mode = name;
  if (name === 'lens' && material !== TYPE_GLASS) selectMaterial(TYPE_GLASS);
  modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === name));
  overlay.style.cursor =
    name === 'erase' ? 'cell' : name === 'move' ? 'default' : 'crosshair';
}

function selectMaterial(t) {
  material = t;
  matButtons.forEach((b) => b.classList.toggle('active', +b.dataset.mat === t));
  if (arcState || gesture) drawOverlay();
}

function bindUI() {
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => selectMode(btn.dataset.mode));
  }
  for (const btn of matButtons) {
    btn.addEventListener('click', () => selectMaterial(+btn.dataset.mat));
  }

  expSlider.addEventListener('input', () => {
    worker.postMessage({ type: 'exposure', value: Math.pow(2, parseFloat(expSlider.value)) });
  });
  expSlider.addEventListener('dblclick', () => {
    expSlider.value = 0;
    expSlider.dispatchEvent(new Event('input'));
  });

  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);
  document.getElementById('clear').addEventListener('click', () => {
    pushHistory();
    prims = [];
    drawOverlay();
    resendScene();
  });
  document.getElementById('save').addEventListener('click', savePng);
  document.getElementById('share').addEventListener('click', shareLink);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault(); redo(); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { cancelInteraction(); drawOverlay(); return; }
    const k = e.key.toLowerCase();
    if (MODE_KEYS[k] !== undefined) { selectMode(MODE_KEYS[k]); return; }
    if (MAT_KEYS[k] !== undefined) selectMaterial(MAT_KEYS[k]);
  });

  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());

  selectMode(mode);
  selectMaterial(material);
}

function eventToCanvas(e) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (W / rect.width),
    y: (e.clientY - rect.top)  * (H / rect.height),
  };
}

function dismissHint() {
  hintEl.classList.add('hide');
}

function onPointerDown(e) {
  overlay.setPointerCapture(e.pointerId);
  const p = eventToCanvas(e);

  // Second stage of the arc tool: this click commits the bent arc.
  if (arcState && arcState.stage === 2) {
    const list = gesturePrims();
    arcState = null;
    commitPrims(list);
    return;
  }

  switch (mode) {
    case 'light':
      pushHistory();
      light = { x: p.x, y: p.y };
      draggingLight = true;
      drawOverlay();
      resendScene();
      return;
    case 'move': {
      const snap = snapshot();
      if (Math.hypot(p.x - light.x, p.y - light.y) < 12) {
        moving = { lightOnly: true, startX: p.x, startY: p.y, snap, moved: false };
        return;
      }
      const hit = hitPrim(p, 8);
      if (hit >= 0) {
        moving = { lightOnly: false, group: prims[hit].group,
                   startX: p.x, startY: p.y, snap, moved: false };
        drawOverlay();
      }
      return;
    }
    case 'erase':
      erasing = true;
      eraseSnapshot = snapshot();
      eraseAt(p);
      return;
    case 'arc':
      arcState = { ax: p.x, ay: p.y, bx: p.x, by: p.y, stage: 1, px: p.x, py: p.y };
      drawOverlay();
      return;
    default: // line | box | circle | lens
      gesture = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      drawOverlay();
  }
}

function onPointerMove(e) {
  const p = eventToCanvas(e);

  if (draggingLight) {
    light = { x: p.x, y: p.y };
    drawOverlay();
    resendScene(true);
    return;
  }
  if (moving) {
    const dx = p.x - moving.startX;
    const dy = p.y - moving.startY;
    moving.moved = moving.moved || Math.hypot(dx, dy) >= 2;
    if (moving.lightOnly) {
      light.x = moving.snap.light.x + dx;
      light.y = moving.snap.light.y + dy;
    } else {
      for (let i = 0; i < prims.length; i++) {
        if (prims[i].group !== moving.group) continue;
        const o = moving.snap.prims[i];
        const t = prims[i];
        if (t.kind === 'seg') {
          t.x1 = o.x1 + dx; t.y1 = o.y1 + dy;
          t.x2 = o.x2 + dx; t.y2 = o.y2 + dy;
        } else {
          t.cx = o.cx + dx; t.cy = o.cy + dy;
        }
      }
    }
    drawOverlay();
    resendScene(true);
    return;
  }
  if (erasing) {
    eraseAt(p);
    return;
  }
  if (arcState) {
    if (arcState.stage === 1) {
      arcState.bx = p.x; arcState.by = p.y;
    } else {
      arcState.px = p.x; arcState.py = p.y;
      resendScene(true);
    }
    drawOverlay();
    return;
  }
  if (gesture) {
    gesture.x2 = p.x;
    gesture.y2 = p.y;
    drawOverlay();
    resendScene(true); // live render preview while drawing
    return;
  }
  if (mode === 'move') {
    const nearLight = Math.hypot(p.x - light.x, p.y - light.y) < 12;
    overlay.style.cursor = nearLight || hitPrim(p, 8) >= 0 ? 'move' : 'default';
  }
}

function onPointerUp(e) {
  if (draggingLight) {
    draggingLight = false;
    dismissHint();
    resendScene();
    return;
  }
  if (moving) {
    const m = moving;
    moving = null;
    if (m.moved) {
      undoStack.push(m.snap);
      if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
      dismissHint();
    } else {
      restore(m.snap); // undo the sub-threshold nudge
    }
    drawOverlay();
    resendScene();
    return;
  }
  if (erasing) {
    erasing = false;
    eraseSnapshot = null;
    return;
  }
  if (arcState && arcState.stage === 1) {
    const p = eventToCanvas(e);
    arcState.bx = p.x; arcState.by = p.y;
    if (Math.hypot(arcState.bx - arcState.ax, arcState.by - arcState.ay) < 6) {
      arcState = null; // too short to be a chord
      drawOverlay();
      resendScene();
    } else {
      arcState.stage = 2; // now bend with the pointer; click to commit
      arcState.px = arcState.bx; arcState.py = arcState.by;
      drawOverlay();
    }
    return;
  }
  if (gesture) {
    const p = eventToCanvas(e);
    gesture.x2 = p.x;
    gesture.y2 = p.y;
    const list = gesturePrims();
    gesture = null;
    if (list.length) commitPrims(list);
    else { drawOverlay(); resendScene(); }
  }
}

function cancelInteraction() {
  if (draggingLight) { draggingLight = false; undo(); }
  if (moving) { restore(moving.snap); moving = null; }
  if (arcState || gesture) {
    arcState = null;
    gesture = null;
    drawOverlay();
    resendScene();
  }
  erasing = false;
  eraseSnapshot = null;
}

// Erase the whole group under the pointer; one undo step per erase gesture.
function eraseAt(p) {
  const idx = hitPrim(p, 6);
  if (idx < 0) return;
  if (eraseSnapshot) {
    undoStack.push(eraseSnapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    eraseSnapshot = null;
  }
  const g = prims[idx].group;
  prims = prims.filter((q) => q.group !== g);
  drawOverlay();
  resendScene();
}

function hitPrim(p, maxDist) {
  let bestIdx = -1;
  let bestD = maxDist;
  for (let i = 0; i < prims.length; i++) {
    const d = prims[i].kind === 'seg'
      ? pointSegmentDist(p.x, p.y, prims[i])
      : pointArcDist(p.x, p.y, prims[i]);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}

function pointSegmentDist(px, py, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - s.x1, py - s.y1);
  let t = ((px - s.x1) * dx + (py - s.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = s.x1 + t * dx;
  const cy = s.y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pointArcDist(px, py, a) {
  const dx = px - a.cx, dy = py - a.cy;
  const ang = Math.atan2(dy, dx);
  if (ccwDist(a.a0, ang) <= a.span) {
    return Math.abs(Math.hypot(dx, dy) - a.r);
  }
  const e0x = a.cx + a.r * Math.cos(a.a0);
  const e0y = a.cy + a.r * Math.sin(a.a0);
  const e1x = a.cx + a.r * Math.cos(a.a0 + a.span);
  const e1y = a.cy + a.r * Math.sin(a.a0 + a.span);
  return Math.min(Math.hypot(px - e0x, py - e0y), Math.hypot(px - e1x, py - e1y));
}

// --- History ----------------------------------------------------------------

function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function snapshot() {
  return {
    light: { x: light.x, y: light.y },
    prims: prims.map((p) => ({ ...p })),
    nextGroup,
  };
}
function restore(snap) {
  light = { x: snap.light.x, y: snap.light.y };
  prims = snap.prims.map((p) => ({ ...p }));
  nextGroup = snap.nextGroup;
  drawOverlay();
  resendScene();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

// --- Save / share -------------------------------------------------------------

function savePng() {
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(view, 0, 0);
  out.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `zentwo-${ts}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

function shareLink() {
  updateHash();
  const btn = document.getElementById('share');
  const done = () => {
    const label = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = label; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(location.href).then(done, () => prompt('Copy link:', location.href));
  } else {
    prompt('Copy link:', location.href);
  }
}
