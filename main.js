// Main thread: UI, scene editing, display.
// Owns the canvas, sends scene to worker, receives accumulator and tone-maps.

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
let imageData = null;
let imageBuf32 = null;

// Scene state.
let light = null;                // {x,y}
let segments = [];               // [{x1,y1,x2,y2,type}]
let history = [];                // snapshots for undo
let future = [];                 // snapshots for redo
let tool = 'light';
let dragging = null;             // {x1,y1,x2,y2,type} during drag

let raysTraced = 0;
let lastRays = 0;
let lastRpsTime = performance.now();
let rps = 0;

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
}

function resize() {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  // Cap total pixel count for performance (~750k, ~3MB float buffer).
  const budget = 750000;
  const scale = Math.min(1, Math.sqrt(budget / (cssW * cssH)));
  W = Math.max(64, Math.floor(cssW * scale));
  H = Math.max(64, Math.floor(cssH * scale));
  view.width = W;
  view.height = H;
  overlay.width = W;
  overlay.height = H;
  imageData = vctx.createImageData(W, H);
  imageBuf32 = new Uint32Array(imageData.data.buffer);

  // Place light in the center if none.
  if (!light) light = { x: W / 2, y: H / 2 };

  worker.postMessage({ type: 'init', width: W, height: H });
  resendScene();
  drawOverlay();
  worker.postMessage({ type: 'start' });
}

// --- Default scene ----------------------------------------------------------

function seedDefaultScene() {
  // Build a sample scene: a few mirrors and a glass slab so first-launch
  // already shows something beautiful.
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.32;
  light = { x: cx, y: cy };
  segments = [
    // Mirror triangle around the light.
    { x1: cx - r,        y1: cy + r * 0.9,
      x2: cx + r,        y2: cy + r * 0.9, type: TYPE_MIRROR },
    { x1: cx - r,        y1: cy + r * 0.9,
      x2: cx - r * 1.4,  y2: cy - r * 0.6, type: TYPE_MIRROR },
    { x1: cx + r,        y1: cy + r * 0.9,
      x2: cx + r * 1.4,  y2: cy - r * 0.6, type: TYPE_MIRROR },
    // Diffuse top.
    { x1: cx - r * 1.4,  y1: cy - r * 0.6,
      x2: cx + r * 1.4,  y2: cy - r * 0.6, type: TYPE_DIFFUSE },
    // Glass shard in the middle.
    { x1: cx - r * 0.35, y1: cy + r * 0.25,
      x2: cx + r * 0.35, y2: cy + r * 0.55, type: TYPE_GLASS },
  ];
  history = [];
  future = [];
}

// --- Worker bridge ----------------------------------------------------------

function resendScene() {
  if (!light) return;
  worker.postMessage({
    type: 'scene',
    segments: segments.slice(),
    light: { x: light.x, y: light.y },
  });
  raysTraced = 0;
  lastRays = 0;
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type !== 'frame') return;
  const accum = new Float32Array(m.buffer);
  raysTraced = m.rays;
  toneMapAndDraw(accum);
  updateStats();
  worker.postMessage({ type: 'ack' });
}

// --- Tone mapping -----------------------------------------------------------

function toneMapAndDraw(accum) {
  // Brightness scales with rays traced, so normalize by ray count to keep
  // the look stable as the image converges. Reinhard tone map + sqrt gamma
  // keeps the hot inner loop free of Math.exp / Math.pow.
  const exposure = Math.pow(2, parseFloat(expSlider.value));
  const norm = (W * H) / Math.max(raysTraced, 1) * 0.6;
  const k = exposure * norm;
  const buf = imageBuf32;
  const n = W * H;
  const ALPHA = 0xff000000 | 0;
  for (let i = 0; i < n; i++) {
    const x = accum[i] * k;
    const v = x / (1 + x);           // Reinhard
    const c = (Math.sqrt(v) * 255) | 0; // gamma ~2.0
    const cc = c > 255 ? 255 : c;
    buf[i] = ALPHA | (cc << 16) | (cc << 8) | cc;
  }
  vctx.putImageData(imageData, 0, 0);
}

function updateStats() {
  const now = performance.now();
  const dt = now - lastRpsTime;
  if (dt > 500) {
    rps = (raysTraced - lastRays) * 1000 / dt;
    lastRays = raysTraced;
    lastRpsTime = now;
    rpsEl.textContent = formatNumber(rps) + ' rays/s';
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

  // Existing segments (faint).
  octx.lineWidth = 1;
  for (const s of segments) {
    octx.strokeStyle = withAlpha(COLORS[s.type], 0.45);
    octx.beginPath();
    octx.moveTo(s.x1, s.y1);
    octx.lineTo(s.x2, s.y2);
    octx.stroke();
  }

  // In-progress drag.
  if (dragging) {
    octx.lineWidth = 1.5;
    octx.strokeStyle = COLORS[dragging.type];
    octx.beginPath();
    octx.moveTo(dragging.x1, dragging.y1);
    octx.lineTo(dragging.x2, dragging.y2);
    octx.stroke();
  }

  // Light marker.
  if (light) {
    const r = 5;
    octx.fillStyle = '#ffd76a';
    octx.beginPath();
    octx.arc(light.x, light.y, r, 0, Math.PI * 2);
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
    // Exposure only affects display, no need to restart.
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
  // Prevent context menu interfering with drawing on right-click.
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
  if (!dragging) return;
  const p = eventToCanvas(e);
  dragging.x2 = p.x;
  dragging.y2 = p.y;
  drawOverlay();
}

function onPointerUp(e) {
  if (!dragging) return;
  const p = eventToCanvas(e);
  dragging.x2 = p.x;
  dragging.y2 = p.y;
  const dx = dragging.x2 - dragging.x1;
  const dy = dragging.y2 - dragging.y1;
  if (Math.hypot(dx, dy) >= 2) {
    pushHistory();
    segments.push(dragging);
    resendScene();
  }
  dragging = null;
  drawOverlay();
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
  // Composite the rendered view (without the overlay) into a new canvas.
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
