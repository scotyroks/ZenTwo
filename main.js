// Main thread: UI and scene editing only. All tracing and tone mapping
// happens in the worker; rendered RGBA frames arrive via transferable
// buffers that are ping-ponged back after putImageData (zero steady-state
// allocation).

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

const toolButtons = document.querySelectorAll('.tool');
const expSlider = document.getElementById('exposure');
const raysEl = document.getElementById('rays');
const rpsEl  = document.getElementById('rps');

let W = 0, H = 0;

// Scene state.
let light = null;                // {x,y}
let segments = [];               // [{x1,y1,x2,y2,type}]
let history = [];                // snapshots for undo
let future = [];                 // snapshots for redo
let tool = 'light';
let dragging = null;             // wall being drawn
let draggingLight = false;

let raysTraced = 0;
let lastRays = 0;
let lastRpsTime = performance.now();

const PREVIEW_MS = 80;           // live-render throttle while dragging
let lastSceneSend = 0;

const worker = new Worker('worker.js');
worker.onmessage = onWorkerMessage;

initCanvas();
seedDefaultScene();
bindUI();
resendScene();

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

  worker.postMessage({ type: 'init', width: W, height: H });
  worker.postMessage({ type: 'exposure', value: Math.pow(2, parseFloat(expSlider.value)) });
  resendScene();
  drawOverlay();
  worker.postMessage({ type: 'start' });
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
  segments = [
    { x1: W * 0.32, y1: -0.1 * H,    x2: W * 0.32, y2: cy - gap,   type: D },
    { x1: W * 0.32, y1: cy + gap,    x2: W * 0.32, y2: 1.1 * H,    type: D },
    { x1: px,       y1: py - 0.95 * p, x2: px - p, y2: py + 0.78 * p, type: G },
    { x1: px - p,   y1: py + 0.78 * p, x2: px + p, y2: py + 0.78 * p, type: G },
    { x1: px + p,   y1: py + 0.78 * p, x2: px,     y2: py - 0.95 * p, type: G },
    { x1: W * 0.25, y1: H * 0.92,    x2: W * 0.97, y2: H * 0.92,   type: D },
    { x1: W * 0.90, y1: H * 0.20,    x2: W * 0.90, y2: H * 0.92,   type: D },
  ];
  history = [];
  future = [];
}

// --- Worker bridge ----------------------------------------------------------

function resendScene(extraSeg, throttled) {
  if (!light) return;
  const now = performance.now();
  if (throttled && now - lastSceneSend < PREVIEW_MS) return;
  lastSceneSend = now;
  const segs = extraSeg ? segments.concat([extraSeg]) : segments.slice();
  worker.postMessage({
    type: 'scene',
    segments: segs,
    light: { x: light.x, y: light.y },
  });
  raysTraced = 0;
  lastRays = 0;
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

// --- Overlay (lines being drawn + light marker) -----------------------------

function drawOverlay() {
  octx.clearRect(0, 0, W, H);

  octx.lineWidth = 1;
  for (const s of segments) {
    octx.strokeStyle = withAlpha(COLORS[s.type], 0.45);
    octx.beginPath();
    octx.moveTo(s.x1, s.y1);
    octx.lineTo(s.x2, s.y2);
    octx.stroke();
  }

  if (dragging) {
    octx.lineWidth = 1.5;
    octx.strokeStyle = COLORS[dragging.type];
    octx.beginPath();
    octx.moveTo(dragging.x1, dragging.y1);
    octx.lineTo(dragging.x2, dragging.y2);
    octx.stroke();
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

function bindUI() {
  for (const btn of toolButtons) {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      toolButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  }

  expSlider.addEventListener('input', () => {
    worker.postMessage({ type: 'exposure', value: Math.pow(2, parseFloat(expSlider.value)) });
  });

  document.getElementById('undo').addEventListener('click', undo);
  document.getElementById('redo').addEventListener('click', redo);
  document.getElementById('clear').addEventListener('click', () => {
    pushHistory();
    segments = [];
    drawOverlay();
    resendScene();
  });
  document.getElementById('save').addEventListener('click', savePng);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault(); redo();
    }
  });

  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());
}

function eventToCanvas(e) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (W / rect.width),
    y: (e.clientY - rect.top)  * (H / rect.height),
  };
}

function onPointerDown(e) {
  overlay.setPointerCapture(e.pointerId);
  const p = eventToCanvas(e);
  if (tool === 'light') {
    pushHistory();
    light = { x: p.x, y: p.y };
    draggingLight = true;
    drawOverlay();
    resendScene();
    return;
  }
  if (tool === 'erase') {
    const idx = findSegmentNear(p.x, p.y, 6);
    if (idx >= 0) {
      pushHistory();
      segments.splice(idx, 1);
      drawOverlay();
      resendScene();
    }
    return;
  }
  const type = typeFromTool(tool);
  dragging = { x1: p.x, y1: p.y, x2: p.x, y2: p.y, type };
  drawOverlay();
}

function onPointerMove(e) {
  if (draggingLight) {
    const p = eventToCanvas(e);
    light = { x: p.x, y: p.y };
    drawOverlay();
    resendScene(null, true);
    return;
  }
  if (!dragging) return;
  const p = eventToCanvas(e);
  dragging.x2 = p.x;
  dragging.y2 = p.y;
  drawOverlay();
  resendScene(dragging, true); // live render preview while drawing
}

function onPointerUp(e) {
  if (draggingLight) {
    draggingLight = false;
    resendScene();
    return;
  }
  if (!dragging) return;
  const p = eventToCanvas(e);
  dragging.x2 = p.x;
  dragging.y2 = p.y;
  const dx = dragging.x2 - dragging.x1;
  const dy = dragging.y2 - dragging.y1;
  if (Math.hypot(dx, dy) >= 2) {
    pushHistory();
    segments.push(dragging);
  }
  dragging = null;
  drawOverlay();
  resendScene();
}

function typeFromTool(t) {
  if (t === 'mirror') return TYPE_MIRROR;
  if (t === 'glass')  return TYPE_GLASS;
  return TYPE_DIFFUSE;
}

function findSegmentNear(x, y, maxDist) {
  let bestIdx = -1;
  let bestD = maxDist;
  for (let i = 0; i < segments.length; i++) {
    const d = pointSegmentDist(x, y, segments[i]);
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

// --- History ----------------------------------------------------------------

function pushHistory() {
  history.push(snapshot());
  if (history.length > 100) history.shift();
  future.length = 0;
}
function snapshot() {
  return {
    light: { x: light.x, y: light.y },
    segments: segments.map((s) => ({ ...s })),
  };
}
function restore(snap) {
  light = { x: snap.light.x, y: snap.light.y };
  segments = snap.segments.map((s) => ({ ...s }));
  drawOverlay();
  resendScene();
}
function undo() {
  if (!history.length) return;
  future.push(snapshot());
  restore(history.pop());
}
function redo() {
  if (!future.length) return;
  history.push(snapshot());
  restore(future.pop());
}

// --- Save -------------------------------------------------------------------

function savePng() {
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(view, 0, 0);
  out.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zentwo.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}
