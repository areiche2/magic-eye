/*
 * Magic Eye (autostereogram) solver — pure computation, no DOM.
 *
 * Model. An autostereogram I satisfies, for every image point p = (x, y) at
 * which a hidden surface of depth z(p) is drawn,
 *
 *     I(x - s(p)/2, y)  ==  I(x + s(p)/2, y)
 *
 * where s(p) is the local horizontal repeat ("separation"). Farther points
 * have a larger separation; the background plane has the largest, P0.
 * Recovering z is therefore recovering s, which is an inverse problem with
 * no unique solution: any s that happens to match locally is admissible,
 * s and s + P0 both match in flat regions, and the two ways of viewing
 * (parallel vs. cross-eyed) flip the sign of the depth.
 *
 * What we minimise. Following the semi-global-matching formulation of
 * stereo (Hirschmüller 2005/2008), we minimise the energy
 *
 *     E(s) = sum_p C(p, s_p)
 *          + sum_{(p,q) neighbours} P1 * [ |s_p - s_q| == 1 ]
 *          + sum_{(p,q) neighbours} P2 * [ |s_p - s_q|  > 1 ]
 *
 * C is a truncated, window-averaged absolute difference between the two
 * half-shifted copies of the image (the data term); the P1/P2 terms are a
 * Potts-like smoothness prior that allows gentle slopes cheaply and pays a
 * fixed price for a depth discontinuity. Exact minimisation of E on a 2-D
 * grid is NP-hard; SGM approximates it by dynamic programming along 8 1-D
 * paths and summing. The period ambiguity is removed by restricting the
 * label set to a band around the auto-detected P0, the sign ambiguity is a
 * user toggle, and the remaining local ambiguities are what the prior
 * arbitrates.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MagicEyeSolver = api;
  root.__magicEyeSolverFactory = factory;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var DEFAULTS = {
    maxWidth: 640,       // processing width; wider inputs are area-downsampled
    period: 0,           // 0 = auto-detect background period P0 (in processed pixels)
    minPeriodFrac: 0.025,// smallest period considered by the detector, as a fraction of width
    maxPeriodFrac: 0.45, // largest period considered by the detector
    nearFrac: 0.35,      // search separations down to P0*(1-nearFrac)  (nearer than background)
    farFrac: 0.15,       // ... and up to P0*(1+farFrac)                 (farther than background)
    windowW: 5,          // matching window (odd)
    windowH: 5,
    tau: 100,            // per-pixel absolute-difference truncation (0..255)
    method: 'sgm',       // 'sgm' | 'wta'
    paths: 8,            // 4 or 8 SGM paths
    p1: 4,               // small-slope penalty (in units of mean abs difference, 0..255)
    p2: 100,             // discontinuity penalty
    fillOcclusions: true,// fill unmatched runs at depth edges with the farther neighbour
    median: true,        // 3x3 median on the separation map
    invert: false,       // flip near/far (cross-eyed stereograms)
    stretch: true,       // percentile contrast stretch of the depth image
    maxCells: 80e6       // refuse cost volumes larger than this (2 x Uint16 per cell)
  };

  var COST_SCALE = 32;   // fixed-point scale for Uint16 cost storage
  var SUM_MAX = 65535;

  function assign(target, src) {
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) target[k] = src[k];
    return target;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Area-average downsample of RGBA bytes to at most maxW wide. Returns
  // interleaved RGB Float32 plus dimensions and the scale factor used.
  function downsample(rgba, w, h, maxW) {
    var scale = 1;
    if (w > maxW) scale = w / maxW;
    var nw = Math.max(1, Math.round(w / scale));
    var nh = Math.max(1, Math.round(h / scale));
    var out = new Float32Array(nw * nh * 3);
    if (scale === 1) {
      for (var i = 0, j = 0, n = w * h; i < n; i++, j += 4) {
        out[i * 3] = rgba[j]; out[i * 3 + 1] = rgba[j + 1]; out[i * 3 + 2] = rgba[j + 2];
      }
      return { rgb: out, w: w, h: h, scale: 1 };
    }
    var sx = w / nw, sy = h / nh;
    for (var y = 0; y < nh; y++) {
      var y0 = Math.floor(y * sy), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      for (var x = 0; x < nw; x++) {
        var x0 = Math.floor(x * sx), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        var r = 0, g = 0, b = 0, c = 0;
        for (var yy = y0; yy < y1; yy++) {
          var row = yy * w;
          for (var xx = x0; xx < x1; xx++) {
            var k = (row + xx) * 4;
            r += rgba[k]; g += rgba[k + 1]; b += rgba[k + 2]; c++;
          }
        }
        var o = (y * nw + x) * 3;
        out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c;
      }
    }
    return { rgb: out, w: nw, h: nh, scale: scale };
  }

  function toGray(rgb, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, n = w * h; i < n; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    return g;
  }

  // Horizontal self-similarity curve M(L) = mean |g(x,y) - g(x+L,y)| over a
  // subsample of rows, for L in [minP, maxP]. The background period is the
  // deepest notch relative to a local baseline.
  function estimatePeriod(gray, w, h, minP, maxP) {
    minP = Math.max(2, Math.floor(minP));
    maxP = Math.min(w - 2, Math.floor(maxP));
    var curve = new Float32Array(maxP + 1);
    for (var i = 0; i < curve.length; i++) curve[i] = NaN;
    if (maxP <= minP) return { period: 0, curve: curve, candidates: [], minLag: minP, maxLag: maxP };
    var rowStep = Math.max(1, Math.floor(h / 96));
    var colStep = w > 800 ? 2 : 1;
    for (var L = minP; L <= maxP; L++) {
      var acc = 0, cnt = 0;
      for (var y = 0; y < h; y += rowStep) {
        var row = y * w;
        for (var x = 0, xe = w - L; x < xe; x += colStep) {
          var d = gray[row + x] - gray[row + x + L];
          acc += d < 0 ? -d : d; cnt++;
        }
      }
      curve[L] = cnt ? acc / cnt : NaN;
    }
    // Local baseline: max over a neighbourhood scaled with L (notch width grows with L).
    var cands = [];
    for (var L2 = minP + 1; L2 < maxP; L2++) {
      var v = curve[L2];
      if (!(v <= curve[L2 - 1] && v < curve[L2 + 1])) continue;
      var half = Math.max(3, Math.round(L2 * 0.3));
      var base = -Infinity;
      for (var k = Math.max(minP, L2 - half); k <= Math.min(maxP, L2 + half); k++) if (curve[k] > base) base = curve[k];
      var prom = base - v;
      var rel = base > 0 ? prom / base : 0;
      cands.push({ lag: L2, value: v, prominence: prom, relative: rel });
    }
    if (!cands.length) return { period: 0, curve: curve, candidates: [], minLag: minP, maxLag: maxP };
    cands.sort(function (a, b) { return b.prominence - a.prominence; });
    // Selection. Every visible surface leaves a notch at its own separation,
    // and every notch repeats at 2x, 3x (harmonics). Nearer surfaces have
    // smaller separations than the background, so: take the strong notches,
    // anchor on the shortest one (the fundamental octave), and call the
    // background the largest lag in that octave.
    var maxProm = cands[0].prominence;
    var strong = cands.filter(function (c) { return c.prominence >= 0.6 * maxProm; });
    strong.sort(function (a, b) { return a.lag - b.lag; });
    var near = function (a, b, tol) { return Math.abs(a - b) <= tol; };
    var pickInOctave = function (anchorIdx) {
      var anchor = strong[anchorIdx].lag, best = strong[anchorIdx], accepted = [anchor], clusterProm = strong[anchorIdx].prominence;
      for (var c = anchorIdx + 1; c < strong.length; c++) {
        var cd = strong[c];
        if (cd.lag >= anchor * 1.5) break;              // next octave: harmonics live there
        // A texture with an internal stripe of width t leaves side-lobes at P0 +/- t:
        // a longer notch whose mirror about the current best is also a notch is a side-lobe.
        var mirror = 2 * best.lag - cd.lag, isSideLobe = false;
        for (var m = 0; m < accepted.length; m++) if (accepted[m] !== best.lag && near(accepted[m], mirror, Math.max(2, 0.04 * best.lag))) isSideLobe = true;
        if (isSideLobe) continue;
        best = cd; accepted.push(cd.lag);
        if (cd.prominence > clusterProm) clusterProm = cd.prominence;
      }
      return { best: best, clusterProm: clusterProm, accepted: accepted };
    };
    var anchorIdx = 0, pick = pickInOctave(0);
    // If a notch at 2x or 3x the chosen lag is clearly deeper than anything in
    // this octave, the short notch is a sub-harmonic of the texture itself
    // (tile repeating inside its own width); move up to the deepest such notch.
    for (var hop = 0; hop < 2; hop++) {
      var target = -1, targetProm = 1.05 * pick.clusterProm;
      for (var k = 2; k <= 3; k++) {
        for (var c2 = 0; c2 < strong.length; c2++) {
          if (near(strong[c2].lag, k * pick.best.lag, 0.08 * pick.best.lag) && strong[c2].prominence > targetProm) { target = c2; targetProm = strong[c2].prominence; }
        }
      }
      if (target < 0) break;
      anchorIdx = target; pick = pickInOctave(target);
    }
    var best = pick.best;
    var octave = pick.accepted;
    // Sub-pixel refine by parabola on the notch.
    var Lb = best.lag, sub = 0;
    if (Lb > minP && Lb < maxP) {
      var a = curve[Lb - 1], b2 = curve[Lb], c2 = curve[Lb + 1];
      var den = a - 2 * b2 + c2;
      if (den > 1e-9) sub = clamp(0.5 * (a - c2) / den, -0.5, 0.5);
    }
    return { period: Lb + sub, curve: curve, candidates: cands.slice(0, 12), octave: octave, minLag: minP, maxLag: maxP };
  }

  // Cost volume C[y][x][s] (s fastest). For separation s the two compared
  // pixels are x - floor(s/2) and x + ceil(s/2), so the cost is centred on
  // the point whose depth it measures.
  function buildCostVolume(rgb, w, h, sMin, sMax, winW, winH, tau, onProgress) {
    var S = sMax - sMin + 1;
    var cost = new Uint16Array(w * h * S);
    var D = new Float32Array(w * h);
    var cum = new Float32Array(w + 1);
    var box = new Float32Array(w * h);
    var rw = winW >> 1, rh = winH >> 1;
    var validLo = new Int32Array(S), validHi = new Int32Array(S);
    var x, y, s, i;
    for (s = sMin; s <= sMax; s++) {
      var si = s - sMin;
      var lo = s >> 1, hi = w - 1 - ((s + 1) >> 1);   // centre range where both pixels exist
      validLo[si] = lo; validHi[si] = hi;
      if (hi < lo) continue;
      var offL = -(s >> 1), offR = (s + 1) >> 1;
      // per-pixel truncated absolute difference (mean over RGB)
      for (y = 0; y < h; y++) {
        var row = y * w;
        for (x = lo; x <= hi; x++) {
          var a = (row + x + offL) * 3, b = (row + x + offR) * 3;
          var dr = rgb[a] - rgb[b], dg = rgb[a + 1] - rgb[b + 1], db = rgb[a + 2] - rgb[b + 2];
          if (dr < 0) dr = -dr; if (dg < 0) dg = -dg; if (db < 0) db = -db;
          var d = (dr + dg + db) * (1 / 3);
          D[row + x] = d > tau ? tau : d;
        }
      }
      // horizontal box (clamped to the valid range)
      for (y = 0; y < h; y++) {
        var r0 = y * w;
        cum[lo] = 0;
        for (x = lo; x <= hi; x++) cum[x + 1] = cum[x] + D[r0 + x];
        for (x = lo; x <= hi; x++) {
          var xa = x - rw < lo ? lo : x - rw, xb = x + rw > hi ? hi : x + rw;
          box[r0 + x] = (cum[xb + 1] - cum[xa]) / (xb - xa + 1);
        }
      }
      // vertical box via column cumulative sums (reuse D as scratch)
      for (x = lo; x <= hi; x++) {
        var acc = 0;
        for (y = 0; y < h; y++) { acc += box[y * w + x]; D[y * w + x] = acc; }
      }
      for (y = 0; y < h; y++) {
        var ya = y - rh < 0 ? 0 : y - rh, yb = y + rh > h - 1 ? h - 1 : y + rh;
        var inv = COST_SCALE / (yb - ya + 1);
        var rowT = y * w;
        for (x = lo; x <= hi; x++) {
          var v = D[yb * w + x] - (ya > 0 ? D[(ya - 1) * w + x] : 0);
          cost[(rowT + x) * S + si] = (v * inv + 0.5) | 0;
        }
      }
      if (onProgress && (si & 3) === 0) onProgress(si / S);
    }
    // Border columns. Separations whose pair falls outside the image are
    // unobservable there; give them the pixel's best observed cost so they are
    // "at least as plausible" and let the smoothness prior arbitrate. Columns
    // where nothing at all is observable get a flat zero row.
    var band = (sMax >> 1) + 1;
    var valid = new Uint8Array(w);      // 1 = every separation observable at this column
    var observable = new Uint8Array(w); // 1 = at least the smallest separation observable
    for (x = 0; x < w; x++) {
      valid[x] = (x >= validLo[S - 1] && x <= validHi[S - 1]) ? 1 : 0;
      observable[x] = (x >= validLo[0] && x <= validHi[0]) ? 1 : 0;
    }
    var cols = [];
    for (x = 0; x < w; x++) if (x < band || x >= w - band) cols.push(x);
    for (y = 0; y < h; y++) {
      for (var ci = 0; ci < cols.length; ci++) {
        x = cols[ci];
        var base = (y * w + x) * S, mn = Infinity;
        for (i = 0; i < S; i++) if (x >= validLo[i] && x <= validHi[i]) { if (cost[base + i] < mn) mn = cost[base + i]; }
        var fill = mn === Infinity ? 0 : mn;
        for (i = 0; i < S; i++) if (!(x >= validLo[i] && x <= validHi[i])) cost[base + i] = fill;
      }
    }
    return { cost: cost, S: S, sMin: sMin, sMax: sMax, valid: valid, observable: observable };
  }

  // Semi-global aggregation over 4 or 8 paths into a Uint16 sum volume.
  // For each direction r the recurrence is
  //   L_r(p,d) = C(p,d) + min( L_r(q,d), L_r(q,d±1)+P1, min_k L_r(q,k)+P2 ) - min_k L_r(q,k)
  // with q = p - r. Rows are processed in path order; horizontal paths read
  // the current row, all others read the previous row.
  function aggregateSGM(cost, w, h, S, p1, p2, nPaths, onProgress) {
    var sum = new Uint16Array(cost.length);
    var P1 = Math.round(p1 * COST_SCALE), P2 = Math.round(p2 * COST_SCALE);
    if (P2 < P1) P2 = P1;
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    if (nPaths >= 8) dirs.push([1, 1], [-1, 1], [1, -1], [-1, -1]);
    var Lprev = new Float32Array(w * S), Lcur = new Float32Array(w * S);
    var minPrev = new Float32Array(w), minCur = new Float32Array(w);
    for (var di = 0; di < dirs.length; di++) {
      var dx = dirs[di][0], dy = dirs[di][1];
      var y0 = dy >= 0 ? 0 : h - 1, y1 = dy >= 0 ? h : -1, ys = dy >= 0 ? 1 : -1;
      var x0 = dx >= 0 ? 0 : w - 1, x1 = dx >= 0 ? w : -1, xs = dx >= 0 ? 1 : -1;
      var haveRow = false;
      for (var y = y0; y !== y1; y += ys) {
        var rowBase = y * w;
        for (var x = x0; x !== x1; x += xs) {
          var qx = x - dx;
          var Lq = null, mq = 0;
          if (qx >= 0 && qx < w) {
            if (dy === 0) { Lq = Lcur; mq = minCur[qx]; }
            else if (haveRow) { Lq = Lprev; mq = minPrev[qx]; }
          }
          var cb = (rowBase + x) * S, lb = x * S, d, v, m = Infinity, t;
          if (Lq === null) {
            for (d = 0; d < S; d++) {
              v = cost[cb + d]; Lcur[lb + d] = v; if (v < m) m = v;
              t = sum[cb + d] + v; sum[cb + d] = t > SUM_MAX ? SUM_MAX : t;
            }
          } else {
            var qb = qx * S, mp2 = mq + P2;
            // rolling window over d-1, d, d+1 of the predecessor's costs
            var Lm1 = Infinity, L0 = Lq[qb], Lp1 = S > 1 ? Lq[qb + 1] : Infinity;
            for (d = 0; d < S; d++) {
              var best = L0;
              v = Lm1 + P1; if (v < best) best = v;
              v = Lp1 + P1; if (v < best) best = v;
              if (mp2 < best) best = mp2;
              v = cost[cb + d] + best - mq;
              Lcur[lb + d] = v; if (v < m) m = v;
              t = sum[cb + d] + v; sum[cb + d] = t > SUM_MAX ? SUM_MAX : t;
              Lm1 = L0; L0 = Lp1; Lp1 = d + 2 < S ? Lq[qb + d + 2] : Infinity;
            }
          }
          minCur[x] = m;
        }
        if (dy !== 0) {
          var sw = Lprev; Lprev = Lcur; Lcur = sw;
          var sm = minPrev; minPrev = minCur; minCur = sm;
          haveRow = true;
        }
        if (onProgress && (y & 31) === 0) onProgress((di + (dy >= 0 ? y / h : (h - 1 - y) / h)) / dirs.length);
      }
    }
    return sum;
  }

  // Winner-take-all with parabolic sub-pixel refinement and a confidence
  // score from the ratio between the best and the second-best (non-adjacent)
  // minimum.
  function winnerTakeAll(vol, w, h, S, sMin) {
    var disp = new Float32Array(w * h), conf = new Float32Array(w * h);
    for (var p = 0, n = w * h; p < n; p++) {
      var base = p * S, bd = 0, bv = Infinity;
      for (var d = 0; d < S; d++) { var v = vol[base + d]; if (v < bv) { bv = v; bd = d; } }
      var sv = Infinity;
      for (d = 0; d < S; d++) { if (d < bd - 1 || d > bd + 1) { v = vol[base + d]; if (v < sv) sv = v; } }
      var sub = 0;
      if (bd > 0 && bd < S - 1) {
        var a = vol[base + bd - 1], c = vol[base + bd + 1];
        var den = a - 2 * bv + c;
        if (den > 0) sub = clamp(0.5 * (a - c) / den, -0.5, 0.5);
      }
      disp[p] = sMin + bd + sub;
      var ratio = sv === Infinity ? 1 : (sv - bv) / (bv + 0.5 * COST_SCALE);
      conf[p] = 1 - Math.exp(-ratio * 4);
    }
    return { disp: disp, conf: conf };
  }

  function median3x3(src, w, h) {
    var out = new Float32Array(src.length), win = new Float32Array(9);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var n = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx; if (xx < 0 || xx >= w) continue;
          win[n++] = src[yy * w + xx];
        }
      }
      // insertion sort of n<=9 values
      for (var i = 1; i < n; i++) { var v = win[i], j = i - 1; while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j--; } win[j + 1] = v; }
      out[y * w + x] = (n & 1) ? win[n >> 1] : 0.5 * (win[(n >> 1) - 1] + win[n >> 1]);
    }
    return out;
  }

  // Occlusion handling. Where the hidden surface jumps, one of the two
  // pixels a background pair would use has been overwritten by the nearer
  // surface, so no separation matches well: the raw cost at the chosen
  // separation stays high. Short runs of such unmatched pixels are filled
  // with the farther (larger-separation) of their row neighbours, the
  // standard stereo assumption that occluded pixels belong to the background.
  function fillOccluded(disp, rawCost, w, h, S, sMin, sMax, observable) {
    var n = w * h, matched = new Float32Array(n), sample = [];
    for (var p = 0; p < n; p++) {
      var d = Math.round(disp[p]) - sMin; if (d < 0) d = 0; if (d >= S) d = S - 1;
      matched[p] = rawCost[p * S + d];
      if ((p & 7) === 0 && observable[p % w]) sample.push(matched[p]);
    }
    if (!sample.length) return null;
    var srt = Float32Array.from(sample).sort();
    var p50 = srt[srt.length >> 1], p75 = srt[(srt.length * 3) >> 2];
    // "unmatched" = clearly worse than the bulk of well-matched pixels
    var thr = Math.max(p75 * 3, p50 + 20 * COST_SCALE);
    var occ = new Uint8Array(n);
    for (var y = 0; y < h; y++) {
      var row = y * w, x = 0;
      while (x < w) {
        if (matched[row + x] <= thr || !observable[x]) { x++; continue; }
        var x0 = x; while (x < w && matched[row + x] > thr && observable[x]) x++;
        var len = x - x0;
        if (x0 === 0 || x >= w) continue;                 // touches the margin: leave to the prior
        var left = disp[row + x0 - 1], right = disp[row + x];
        var jump = Math.abs(left - right);
        // an occlusion zone sits next to a depth edge and is about as wide as the jump
        if (jump < 1.5 || len > jump * 1.5 + 3) continue;
        var fill = Math.max(left, right);
        for (var k = x0; k < x; k++) { disp[row + k] = fill; occ[row + k] = 1; }
      }
    }
    return occ;
  }

  // Columns where no separation is observable copy the nearest observable column.
  function fillUnobservable(disp, observable, w, h) {
    var first = -1, last = -1;
    for (var x = 0; x < w; x++) if (observable[x]) { if (first < 0) first = x; last = x; }
    if (first < 0) return;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < first; x++) disp[row + x] = disp[row + first];
      for (x = last + 1; x < w; x++) disp[row + x] = disp[row + last];
    }
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    var i = clamp(Math.round(q * (sorted.length - 1)), 0, sorted.length - 1);
    return sorted[i];
  }

  // Map separations to an 8-bit depth image. Near (small separation) -> bright.
  function toDepthImage(disp, valid, w, h, sMin, sMax, invert, stretch) {
    var lo = sMin, hi = sMax;
    if (stretch) {
      var vals = [];
      for (var y = 0; y < h; y += 2) for (var x = 0; x < w; x += 2) if (valid[x]) vals.push(disp[y * w + x]);
      if (!vals.length) for (var i = 0; i < disp.length; i += 4) vals.push(disp[i]);
      var arr = Float32Array.from(vals).sort();
      lo = percentile(arr, 0.005); hi = percentile(arr, 0.995);
      if (hi - lo < 1) { var mid = 0.5 * (lo + hi); lo = mid - 0.5; hi = mid + 0.5; }
    }
    var out = new Uint8ClampedArray(w * h);
    var k = 255 / (hi - lo);
    for (var p = 0; p < disp.length; p++) {
      var t = (disp[p] - lo) * k;           // 0 = near (small separation) ... 255 = far
      var v = invert ? t : 255 - t;         // default: near = bright
      out[p] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return { depth: out, lo: lo, hi: hi };
  }

  function sanitize(opts) {
    var numeric = ['maxWidth', 'period', 'minPeriodFrac', 'maxPeriodFrac', 'nearFrac', 'farFrac', 'windowW', 'windowH', 'tau', 'paths', 'p1', 'p2', 'maxCells'];
    for (var i = 0; i < numeric.length; i++) {
      var k = numeric[i], v = Number(opts[k]);
      opts[k] = isFinite(v) ? v : DEFAULTS[k];
    }
    opts.maxWidth = clamp(Math.round(opts.maxWidth), 16, 8192);
    opts.nearFrac = clamp(opts.nearFrac, 0, 0.95);
    opts.farFrac = clamp(opts.farFrac, 0, 3);
    opts.tau = clamp(opts.tau, 1, 255);
    opts.p1 = Math.max(0, opts.p1); opts.p2 = Math.max(0, opts.p2);
    opts.windowW = clamp(Math.round(opts.windowW), 1, 99); opts.windowH = clamp(Math.round(opts.windowH), 1, 99);
    opts.paths = opts.paths >= 8 ? 8 : 4;
    opts.method = opts.method === 'wta' ? 'wta' : 'sgm';
    return opts;
  }

  function solve(rgba, width, height, options, onProgress) {
    var opts = sanitize(assign(assign({}, DEFAULTS), options || {}));
    var t0 = now();
    var timing = {};
    var progress = function (stage, frac) { if (onProgress) onProgress(stage, frac); };

    progress('Preparing image', 0);
    var ds = downsample(rgba, width, height, opts.maxWidth);
    var w = ds.w, h = ds.h, rgb = ds.rgb;
    var gray = toGray(rgb, w, h);
    timing.prepare = now() - t0;

    progress('Detecting period', 0);
    var t1 = now();
    var minP = Math.max(4, Math.round(w * opts.minPeriodFrac));
    var maxP = Math.max(minP + 2, Math.round(w * opts.maxPeriodFrac));
    var pd = estimatePeriod(gray, w, h, minP, maxP);
    var P0 = opts.period > 0 ? opts.period / ds.scale : pd.period;
    timing.period = now() - t1;
    if (!(P0 > 2)) {
      throw new Error('Could not find a repeating pattern. Set the period manually.');
    }
    var sMin = Math.max(2, Math.floor(P0 * (1 - opts.nearFrac)));
    var sMax = Math.min(w - 2, Math.ceil(P0 * (1 + opts.farFrac)));
    // If the hidden object dominates the picture its separation wins the
    // period vote and the true background (a weaker notch above P0) can fall
    // outside the band. Cheap insurance: widen the band to cover any notch
    // with non-trivial prominence up to 1.3*P0. Not further: beyond that the
    // curve fills with "sum" notches (background + object separation, from
    // matches that chain across two surfaces) that must not enter the band.
    var bandExtendedTo = 0;
    if (opts.period <= 0 && pd.candidates.length) {
      var top = pd.candidates[0].prominence, known = (pd.octave || []).concat([P0]);
      for (var ci = 0; ci < pd.candidates.length; ci++) {
        var cnd = pd.candidates[ci];
        if (!(cnd.lag > sMax && cnd.lag <= 1.3 * P0 && cnd.prominence >= 0.15 * top)) continue;
        // skip harmonics (2x, 3x) of notches we already know about
        var isHarmonic = false;
        for (var ki = 0; ki < known.length && !isHarmonic; ki++) for (var mult = 2; mult <= 3; mult++) if (Math.abs(cnd.lag - mult * known[ki]) <= 0.08 * known[ki]) isHarmonic = true;
        if (isHarmonic) continue;
        var ext = Math.min(w - 2, Math.ceil(cnd.lag + 0.05 * P0));
        if (ext > sMax) { sMax = ext; bandExtendedTo = cnd.lag; }
      }
    }
    if (sMax - sMin < 2) sMax = sMin + 2;
    var S = sMax - sMin + 1;
    var cells = w * h * S;
    if (cells > opts.maxCells) throw new Error('Search too large (' + Math.round(cells / 1e6) + 'M cells). Lower the processing width or the search range.');

    progress('Matching', 0);
    var t2 = now();
    var winW = Math.max(1, opts.windowW | 1), winH = Math.max(1, opts.windowH | 1);
    var cv = buildCostVolume(rgb, w, h, sMin, sMax, winW, winH, opts.tau, function (f) { progress('Matching', f); });
    timing.cost = now() - t2;

    var vol = cv.cost;
    var t3 = now();
    if (opts.method === 'sgm') {
      progress('Smoothing (SGM)', 0);
      vol = aggregateSGM(cv.cost, w, h, S, opts.p1, opts.p2, opts.paths, function (f) { progress('Smoothing (SGM)', f); });
    }
    timing.aggregate = now() - t3;

    progress('Extracting depth', 0);
    var t4 = now();
    var wta = winnerTakeAll(vol, w, h, S, sMin);
    var disp = wta.disp;
    var occ = opts.fillOcclusions ? fillOccluded(disp, cv.cost, w, h, S, sMin, sMax, cv.observable) : null;
    fillUnobservable(disp, cv.observable, w, h);
    if (opts.median) disp = median3x3(disp, w, h);
    var dimg = toDepthImage(disp, cv.valid, w, h, sMin, sMax, opts.invert, opts.stretch);
    // fraction of observable pixels pinned to the edge of the search band
    var clipped = 0, obsCount = 0;
    for (var q = 0; q < disp.length; q++) {
      if (!cv.observable[q % w]) continue;
      obsCount++;
      if (disp[q] <= sMin + 0.5 || disp[q] >= sMax - 0.5) clipped++;
    }
    var conf8 = new Uint8ClampedArray(w * h);
    for (var p = 0; p < conf8.length; p++) conf8[p] = occ && occ[p] ? 0 : Math.round(255 * wta.conf[p] * (cv.valid[p % w] ? 1 : 0.35));
    timing.extract = now() - t4;
    timing.total = now() - t0;

    return {
      width: w, height: h, scale: ds.scale,
      period: P0, periodOriginal: P0 * ds.scale, autoPeriod: pd.period, curve: pd.curve, candidates: pd.candidates,
      sMin: sMin, sMax: sMax, depthLo: dimg.lo, depthHi: dimg.hi,
      minLag: pd.minLag, maxLag: pd.maxLag, bandExtendedTo: bandExtendedTo, clippedFraction: obsCount ? clipped / obsCount : 0,
      disparity: disp, depth: dimg.depth, confidence: conf8, valid: cv.valid, observable: cv.observable,
      occluded: occ, timing: timing, options: opts
    };
  }

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  return {
    DEFAULTS: DEFAULTS,
    solve: solve,
    estimatePeriod: estimatePeriod,
    downsample: downsample,
    toGray: toGray,
    buildCostVolume: buildCostVolume,
    aggregateSGM: aggregateSGM,
    winnerTakeAll: winnerTakeAll,
    median3x3: median3x3,
    toDepthImage: toDepthImage
  };
});
