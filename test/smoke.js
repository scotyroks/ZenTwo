// Headless physics smoke test: node test/smoke.js
//
// Runs worker.js under a stubbed `self` and checks two invariants:
//  1. An empty scene renders perfectly neutral (spectral white balance).
//  2. A slit + prism (Newton's experiment) produces dispersion, with blue
//     deviated further than red.
//
// The stub returns frame buffers synchronously; in a browser the ack
// arrives FIFO on the posted-message task source, which interleaves the
// same way.

'use strict';
const fs = require('fs');
const path = require('path');

const W = 320, H = 240;

function runScene(light, segments, ms) {
  return new Promise((resolve) => {
    let lastFrame = null;
    global.self = {
      onmessage: null,
      postMessage: (msg) => {
        if (msg.type === 'frame') {
          lastFrame = msg;
          global.self.onmessage({ data: { type: 'ack', buffer: msg.buffer } });
        }
      },
    };
    // Fresh evaluation per scene for isolated state.
    eval(fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8'));
    const post = (data) => global.self.onmessage({ data });
    post({ type: 'init', width: W, height: H });
    post({ type: 'exposure', value: 1 });
    post({ type: 'scene', light, segments });
    post({ type: 'start' });
    setTimeout(() => {
      post({ type: 'stop' });
      resolve(lastFrame);
    }, ms);
  });
}

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

(async () => {
  // 1. Empty scene: undispersed light must be neutral white.
  {
    const frame = await runScene({ x: 80, y: 120 }, [], 3000);
    const px = new Uint8Array(frame.buffer);
    let r = 0, g = 0, b = 0, maxChroma = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]; g += px[i + 1]; b += px[i + 2];
      const c = Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]);
      if (c > maxChroma) maxChroma = c;
    }
    const n = px.length / 4;
    console.log(`empty scene: rays=${(frame.rays / 1e6).toFixed(2)}M ` +
      `means=${(r / n).toFixed(1)}/${(g / n).toFixed(1)}/${(b / n).toFixed(1)} maxChroma=${maxChroma}`);
    if (frame.rays < 100000) fail('too few rays traced');
    const mean = (r + g + b) / (3 * n);
    if (mean < 30) fail('image too dark');
    if (mean > 250) fail('image blown out');
    if (Math.abs(r - g) / (g || 1) > 0.02 || Math.abs(b - g) / (g || 1) > 0.02) {
      fail('white balance is off');
    }
  }

  // 2. Newton's experiment: slit-collimated beam through a BK7 prism.
  {
    const frame = await runScene({ x: 40, y: 120 }, [
      { x1: 100, y1: -50, x2: 100, y2: 116, type: 0 },
      { x1: 100, y1: 124, x2: 100, y2: 290, type: 0 },
      { x1: 160, y1: 75,  x2: 125, y2: 165, type: 2 },
      { x1: 125, y1: 165, x2: 195, y2: 165, type: 2 },
      { x1: 195, y1: 165, x2: 160, y2: 75,  type: 2 },
    ], 4000);
    const px = new Uint8Array(frame.buffer);
    let redDom = 0, blueDom = 0, redY = 0, blueY = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], b = px[i + 2];
      const y = ((i / 4) / W) | 0;
      if (r > b + 20 && r > 30) { redDom++; redY += y; }
      if (b > r + 20 && b > 30) { blueDom++; blueY += y; }
    }
    console.log(`prism scene: rays=${(frame.rays / 1e6).toFixed(2)}M ` +
      `red px=${redDom} (ȳ=${redDom ? (redY / redDom).toFixed(0) : '-'}) ` +
      `blue px=${blueDom} (ȳ=${blueDom ? (blueY / blueDom).toFixed(0) : '-'})`);
    if (redDom < 60 || blueDom < 60) fail('no visible dispersion');
    // Apex-up prism deviates toward the base (down); blue bends more.
    if (blueY / blueDom <= redY / redDom) fail('dispersion order wrong (blue should deviate more)');
  }

  console.log('OK');
  process.exit(0);
})();
