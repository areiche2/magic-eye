/* ============================================================================
   generator.js — the canonical forward model, used for built-in examples and
   for the self-test. This is Thimbleby / Inglis / Witten (IEEE Computer, 1994)
   Figure 3, including hidden-surface removal and the same-colour constraint
   propagation, transcribed to JavaScript.

   Having the exact generator in the page matters: the output of an inverse
   solver is otherwise unverifiable by eye. The self-test generates a KNOWN
   depth map, encodes it, solves it, and reports the correlation.
   ========================================================================= */
(function (root) {
  'use strict';

  function separation(Z, E, mu) { return Math.round((1 - mu * Z) * E / (2 - mu * Z)); }

  /** Deterministic PRNG so examples and self-tests are reproducible. */
  function rng(seed) {
    var a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Canonical SIRDS. Z is Float32Array(w*h) in [0,1]; 0 = far, 1 = near. */
  function generate(Z, w, h, opts) {
    opts = opts || {};
    var E = opts.E || 160, mu = opts.mu || (1 / 3);
    var colour = opts.colour !== false;
    var rand = rng(opts.seed || 12345);

    var rgba = new Uint8ClampedArray(w * h * 4);
    var same = new Int32Array(w);
    var pix = new Int32Array(w);

    for (var y = 0; y < h; y++) {
      var row = y * w, x;
      for (x = 0; x < w; x++) same[x] = x;

      for (x = 0; x < w; x++) {
        var s = separation(Z[row + x], E, mu);
        var left = x - (s >> 1), right = left + s;
        if (0 <= left && right < w) {
          // hidden-surface removal
          var visible = true, t = 1, zt;
          do {
            zt = Z[row + x] + 2 * (2 - mu * Z[row + x]) * t / (mu * E);
            visible = (x - t >= 0 && x + t < w)
              ? (Z[row + x - t] < zt && Z[row + x + t] < zt)
              : true;
            t++;
          } while (visible && zt < 1);

          if (visible) {
            var l = same[left];
            while (l !== left && l !== right) {
              if (l < right) { left = l; l = same[left]; }
              else { same[left] = right; left = right; l = same[left]; right = l; }
            }
            same[left] = right;
          }
        }
      }

      for (x = w - 1; x >= 0; x--) {
        if (same[x] === x) pix[x] = (rand() * 16777216) | 0;
        else pix[x] = pix[same[x]];
        var o = (row + x) << 2;
        if (colour) {
          rgba[o] = pix[x] & 255;
          rgba[o + 1] = (pix[x] >> 8) & 255;
          rgba[o + 2] = (pix[x] >> 16) & 255;
        } else {
          var v = (pix[x] & 1) ? 235 : 20;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        }
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }

  /* ----------------------------------------------------------- test scenes */

  var SCENES = {
    sphere: function (x, y, w, h) {
      var u = (x / w - 0.5) * 2, v = (y / h - 0.5) * 2, r = Math.sqrt(u * u + v * v);
      return r < 0.62 ? Math.sqrt(1 - (r / 0.62) * (r / 0.62)) * 0.92 : 0;
    },
    shapes: function (x, y, w, h) {
      var u = (x / w - 0.5) * 2, v = (y / h - 0.5) * 2, z = 0;
      if (Math.abs(u) < 0.52 && Math.abs(v) < 0.5) z = 0.34;
      if (u > -0.78 && u < -0.3 && v > 0.02 && v < 0.56) z = 0.62;
      var r = Math.sqrt((u - 0.38) * (u - 0.38) + (v + 0.3) * (v + 0.3));
      if (r < 0.3) z = 0.92;
      return z;
    },
    terrain: function (x, y, w, h) {
      var u = x / w * 6, v = y / h * 4;
      var z = 0.5 + 0.22 * Math.sin(u) * Math.cos(v) + 0.16 * Math.sin(u * 2.3 + 1.1) * Math.sin(v * 1.7);
      return Math.max(0, Math.min(0.95, z));
    },
    rings: function (x, y, w, h) {
      var u = (x / w - 0.5) * 2, v = (y / h - 0.5) * 2, r = Math.sqrt(u * u + v * v);
      if (r > 0.85) return 0;
      return 0.15 + 0.8 * (0.5 + 0.5 * Math.cos(r * 14));
    },
    steps: function (x, y, w, h) {
      var u = (x / w - 0.5) * 2, v = (y / h - 0.5) * 2;
      if (Math.abs(u) > 0.8 || Math.abs(v) > 0.7) return 0;
      return Math.floor(((x / w) * 5)) / 5 * 0.9 + 0.05;
    }
  };

  function scene(name, w, h) {
    var fn = SCENES[name] || SCENES.sphere;
    var Z = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var z = fn(x, y, w, h);
        Z[y * w + x] = z < 0 ? 0 : z > 1 ? 1 : z;
      }
    }
    return Z;
  }

  root.MagicEyeGenerator = {
    generate: generate,
    separation: separation,
    scene: scene,
    sceneNames: Object.keys(SCENES),
    rng: rng
  };
})(typeof self !== 'undefined' ? self : this);
