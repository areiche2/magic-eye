(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Stereogram = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
// Ground-truth autostereogram generator: Thimbleby, Inglis & Witten (1994),
// "Displaying 3D Images: Algorithms for Single-Image Random-Dot Stereograms".
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Z: Float32Array(w*h) in [0,1], 0 = far plane, 1 = nearest.
// pattern: null for random dots, or {w,h,rgb:Uint8Array} tile.
function generate(Z, w, h, { E = 180, mu = 1 / 3, pattern = null, seed = 1, color = true } = {}) {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(w * h * 4);
  const sep = new Float32Array(w * h);
  const same = new Int32Array(w);
  const separation = z => Math.round((1 - mu * z) * E / (2 - mu * z));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) same[x] = x;
    for (let x = 0; x < w; x++) {
      const z = Z[y * w + x];
      const s = separation(z);
      sep[y * w + x] = s;
      let left = x - (s >> 1), right = left + s;
      if (left >= 0 && right < w) {
        // hidden-surface removal
        let visible = true, t = 1, zt;
        do {
          zt = z + 2 * (2 - mu * z) * t / (mu * E);
          visible = Z[y * w + x - t] < zt && Z[y * w + x + t] < zt;
          t++;
        } while (visible && zt < 1 && x - t >= 0 && x + t < w);
        if (visible) {
          let l = same[left];
          while (l !== left && l !== right) { if (l < right) { left = l; l = same[left]; } else { same[left] = right; left = right; l = same[left]; right = l; } }
          same[left] = right;
        }
      }
    }
    for (let x = w - 1; x >= 0; x--) {
      const o = (y * w + x) * 4;
      if (same[x] === x) {
        if (pattern) {
          const px = ((x % pattern.w) + pattern.w) % pattern.w, py = y % pattern.h, po = (py * pattern.w + px) * 3;
          out[o] = pattern.rgb[po]; out[o + 1] = pattern.rgb[po + 1]; out[o + 2] = pattern.rgb[po + 2];
        } else if (color) {
          out[o] = rnd() * 256 | 0; out[o + 1] = rnd() * 256 | 0; out[o + 2] = rnd() * 256 | 0;
        } else {
          const v = rnd() < 0.5 ? 0 : 255; out[o] = out[o + 1] = out[o + 2] = v;
        }
      } else {
        const s = (y * w + same[x]) * 4;
        out[o] = out[s]; out[o + 1] = out[s + 1]; out[o + 2] = out[s + 2];
      }
      out[o + 3] = 255;
    }
  }
  return { rgba: out, sep, farSep: separation(0), nearSep: separation(1) };
}

// Smooth colourful tile, like a commercial "pattern" stereogram.
function makePattern(w, h, seed = 7) {
  const rnd = mulberry32(seed);
  const rgb = new Uint8Array(w * h * 3);
  const blobs = [];
  for (let i = 0; i < 24; i++) blobs.push({ x: rnd() * w, y: rnd() * h, r: 4 + rnd() * 14, c: [rnd() * 255, rnd() * 255, rnd() * 255] });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 30 + rnd() * 40, g = 30 + rnd() * 40, b = 60 + rnd() * 40;
    for (const bl of blobs) {
      // toroidal distance so the tile wraps seamlessly
      let dx = Math.abs(x - bl.x), dy = Math.abs(y - bl.y); dx = Math.min(dx, w - dx); dy = Math.min(dy, h - dy);
      const wgt = Math.exp(-(dx * dx + dy * dy) / (bl.r * bl.r));
      r += wgt * bl.c[0]; g += wgt * bl.c[1]; b += wgt * bl.c[2];
    }
    const o = (y * w + x) * 3; rgb[o] = Math.min(255, r); rgb[o + 1] = Math.min(255, g); rgb[o + 2] = Math.min(255, b);
  }
  return { w, h, rgb };
}

// Test depth maps ------------------------------------------------------------
function depthSphere(w, h) {
  const Z = new Float32Array(w * h), cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d2 = (x - cx) ** 2 + (y - cy) ** 2; Z[y * w + x] = d2 < R * R ? Math.sqrt(1 - d2 / (R * R)) : 0; }
  return Z;
}
function depthSteps(w, h) { // three flat plateaus + a ramp: tests discontinuities and slopes
  const Z = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let z = 0;
    if (x > w * 0.15 && x < w * 0.4 && y > h * 0.2 && y < h * 0.8) z = 0.9;
    if (x > w * 0.5 && x < w * 0.85 && y > h * 0.15 && y < h * 0.5) z = 0.5;
    if (x > w * 0.5 && x < w * 0.85 && y > h * 0.55 && y < h * 0.85) z = (x - w * 0.5) / (w * 0.35);
    Z[y * w + x] = z;
  }
  return Z;
}
function depthTorus(w, h) {
  const Z = new Float32Array(w * h), cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3, r = Math.min(w, h) * 0.12;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x - cx, y - cy) - R; Z[y * w + x] = Math.abs(d) < r ? Math.sqrt(1 - (d / r) ** 2) : 0; }
  return Z;
}
return { generate, makePattern, depthSphere, depthSteps, depthTorus, mulberry32 };

});
