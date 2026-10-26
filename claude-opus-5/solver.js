/* ============================================================================
   solver.js — Magic Eye (autostereogram) depth recovery.

   Recovers the grayscale depth map that generated a single-image stereogram by
   MAP estimation over the disparity field:

       E(d) = SUM_x D_x(d_x)  +  lambda SUM_(x,x') V(d_x, d_x')

   Data term  D : census-transform Hamming distance, per RGB channel, sampled
                  symmetrically at x -/+ d/2 to match the generator's own
                  symmetric constraint  I(x - s/2) == I(x + s/2).
   Prior      V : truncated-linear (P1 for +/-1, P2 beyond) = total-variation /
                  Potts. Edge preserving. Weighted anisotropically: vertical
                  neighbours count for more, because the generator processes
                  scan lines independently, so matching noise is independent
                  per row while true depth is vertically correlated.
   Minimiser    : Semi-Global Matching (Hirschmuller 2008), 4 or 8 paths.

   No dependencies. No network. Pure typed-array JavaScript.
   ========================================================================= */

(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  function popcount(v) {
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    v = (v + (v >> 4)) & 0x0f0f0f0f;
    return (v * 0x01010101) >> 24;
  }

  /** Area-average resample of RGBA data. Preserves more carrier texture than
   *  naive subsampling, which aliases random-dot patterns badly. */
  function resampleRGBA(src, sw, sh, dw, dh) {
    if (sw === dw && sh === dh) return src;
    var out = new Uint8ClampedArray(dw * dh * 4);
    var xr = sw / dw, yr = sh / dh;
    for (var y = 0; y < dh; y++) {
      var y0 = Math.floor(y * yr), y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * yr)));
      for (var x = 0; x < dw; x++) {
        var x0 = Math.floor(x * xr), x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * xr)));
        var r = 0, g = 0, b = 0, n = 0;
        for (var yy = y0; yy < y1; yy++) {
          var rowOff = yy * sw;
          for (var xx = x0; xx < x1; xx++) {
            var i = (rowOff + xx) << 2;
            r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
          }
        }
        var o = ((y * dw) + x) << 2;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return out;
  }

  function toGray(rgba, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
    return g;
  }

  /* ------------------------------------------------- 1. period estimation */

  /**
   * Normalised horizontal autocorrelation, row-subsampled.
   *
   * The background (far) plane repeats with period exactly `far` = E/2, which is
   * also the maximum possible separation. So the fundamental peak of the
   * horizontal autocorrelation IS the disparity upper bound. Harmonics appear at
   * 2T, 3T..., so we deliberately take the *smallest* strong local maximum.
   */
  function estimatePeriod(gray, w, h, opts) {
    opts = opts || {};
    var mu = (opts.mu > 0 && opts.mu < 1) ? opts.mu : (1 / 3);
    var minLag = Math.max(6, Math.round(opts.minLag || w / 30));
    var maxLag = Math.min(w - 8, Math.round(opts.maxLag || w / 3.2));
    if (maxLag <= minLag + 4) maxLag = Math.min(w - 8, minLag + 40);
    if (maxLag <= minLag) {
      // Too narrow to hold any repeating carrier; report a neutral estimate
      // and let the caller decide.
      return { period: Math.max(6, Math.floor(w / 3)), strength: 0, noise: 1,
               bandLo: 0, peakLag: 0, minLag: minLag, curve: new Float32Array(0) };
    }

    // Subsample rows: ~120 rows is ample and keeps this cheap.
    var step = Math.max(1, Math.floor(h / 120));

    // Per-row zero-mean copies.
    var rows = [], ri;
    for (var y = 0; y < h; y += step) {
      var off = y * w, mean = 0;
      for (var x = 0; x < w; x++) mean += gray[off + x];
      mean /= w;
      var r = new Float32Array(w);
      for (x = 0; x < w; x++) r[x] = gray[off + x] - mean;
      rows.push(r);
    }

    var nLags = maxLag - minLag + 1;
    var ncc = new Float32Array(nLags);
    for (var lag = minLag; lag <= maxLag; lag++) {
      var sab = 0, saa = 0, sbb = 0;
      for (ri = 0; ri < rows.length; ri++) {
        var rw = rows[ri], n = w - lag;
        for (x = 0; x < n; x++) {
          var a = rw[x], b = rw[x + lag];
          sab += a * b; saa += a * a; sbb += b * b;
        }
      }
      var den = Math.sqrt(saa * sbb);
      ncc[lag - minLag] = den > 1e-9 ? sab / den : 0;
    }

    // --- picking T ------------------------------------------------------
    // T = far = E/2 is the separation of the FAR plane, which is also the
    // MAXIMUM possible separation. Every depth plane present in the scene
    // contributes its own autocorrelation spike at its own separation, so the
    // significant-correlation band spans [near, far]. The correct estimator for
    // T is therefore the UPPER EDGE of that band -- not the peak. Taking the
    // peak underestimates T whenever the scene has no dominant far-plane
    // background (a ramp, a full-frame object), which then pushes the true
    // far-plane disparity outside the search range entirely.
    var best = -2, bestLag = minLag, i;
    for (i = 0; i < nLags; i++) if (ncc[i] > best) { best = ncc[i]; bestLag = minLag + i; }

    // Robust noise floor: median of |ncc| over the whole curve.
    var mags = new Float32Array(nLags);
    for (i = 0; i < nLags; i++) mags[i] = Math.abs(ncc[i]);
    mags.sort();
    var noise = mags[nLags >> 1] || 1e-4;

    var thresh = Math.max(4 * noise, 0.12 * best);
    var sig = [];
    for (i = 0; i < nLags; i++) if (ncc[i] >= thresh) sig.push(minLag + i);

    var fundamental = bestLag;
    if (sig.length) {
      // Keep only the lowest cluster. The fundamental band spans
      // [2(1-mu)/(2-mu), 1] * T, so its width RATIO is exactly 1/physLo -- and
      // it depends on mu. A fixed cutoff is wrong at both ends: 1.6x truncates
      // the band once mu > ~0.55 (chopping the far plane off the top, which
      // then puts the true disparity outside the search range), and is looser
      // than necessary at the default mu = 1/3. Derive it, and keep it below
      // 2.0 so the 2T harmonic is always excluded.
      var physLo = 2 * (1 - mu) / (2 - mu);
      var cutoff = Math.min(1.9, 1 / Math.max(0.2, physLo) + 0.1) * sig[0];
      fundamental = sig[0];
      for (i = 0; i < sig.length; i++) if (sig[i] <= cutoff && sig[i] > fundamental) fundamental = sig[i];
    }

    return {
      period: fundamental,
      strength: best,
      noise: noise,
      bandLo: sig.length ? sig[0] : bestLag,
      bandCount: sig.length,
      peakLag: bestLag,
      minLag: minLag,
      curve: ncc
    };
  }

  /* ---------------------------------------------------- 2. census transform */

  /** 5x5 census per channel -> 24 bits in a Uint32. Encodes only the ordering
   *  of neighbouring intensities, so it is exactly invariant to any monotonic
   *  local contrast change (the shading/vignetting commercial Magic Eyes apply). */
  var CENSUS_R = 2; // radius -> 5x5

  function censusChannel(rgba, w, h, channel) {
    var out = new Uint32Array(w * h);
    for (var y = CENSUS_R; y < h - CENSUS_R; y++) {
      for (var x = CENSUS_R; x < w - CENSUS_R; x++) {
        var ci = ((y * w) + x) << 2;
        var c = rgba[ci + channel];
        var bits = 0, bit = 0;
        for (var dy = -CENSUS_R; dy <= CENSUS_R; dy++) {
          var ro = ((y + dy) * w) << 2;
          for (var dx = -CENSUS_R; dx <= CENSUS_R; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (rgba[ro + ((x + dx) << 2) + channel] > c) bits |= (1 << bit);
            bit++;
          }
        }
        out[(y * w) + x] = bits;
      }
    }
    return out;
  }

  /* -------------------------------------------------------- 3. cost volume */

  /**
   * C[(y*w + x)*D + k] = census Hamming distance between the pixels the
   * generator would have tied together for disparity d = dMin + k, sampled
   * symmetrically about x exactly as the reference algorithm does:
   *     left = x - (d>>1);  right = left + d
   * Max value 24*3 = 72, so Uint8 suffices.
   */
  var INVALID_COST = 73;

  function buildCostVolume(cR, cG, cB, w, h, dMin, dMax, onProgress) {
    var D = dMax - dMin + 1;
    var C = new Uint8Array(w * h * D);
    C.fill(INVALID_COST);
    // supported[i] = 1 only if EVERY candidate disparity has both partners on
    // screen. Partial support is poison: the winner is then chosen over a
    // biased subset of the range, yet still looks confident. The generator
    // itself skips the constraint when left < 0, so the outer ~dMax/2 columns
    // carry no depth information at all and must be marked unknown.
    var supported = new Uint8Array(w * h);
    var lo = CENSUS_R, hiX = w - CENSUS_R - 1;
    var xFrom = lo + (dMax >> 1);
    var xTo = hiX - (dMax - (dMax >> 1));

    for (var y = CENSUS_R; y < h - CENSUS_R; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var base = (row + x) * D;
        for (var k = 0; k < D; k++) {
          var d = dMin + k;
          var xl = x - (d >> 1), xr = xl + d;
          if (xl < lo || xr > hiX) continue;
          var il = row + xl, ir = row + xr;
          C[base + k] =
            popcount(cR[il] ^ cR[ir]) +
            popcount(cG[il] ^ cG[ir]) +
            popcount(cB[il] ^ cB[ir]);
        }
        if (x >= xFrom && x <= xTo) supported[row + x] = 1;
      }
      if (onProgress && (y & 31) === 0) onProgress(y / h);
    }
    return { C: C, D: D, supported: supported };
  }

  /* --------------------------------------------- 4. SGM path aggregation */

  var PATHS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  var PATHS_8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

  /**
   * Accumulate the exact 1-D minimum of the truncated-linear energy along
   * direction (ux,uy) into S:
   *   L(p,d) = C(p,d) + min( L(p-,d), L(p-,d+/-1)+P1, minL(p-)+P2 ) - minL(p-)
   *
   * `weight` scales the contribution — vertical paths get more, because
   * scan-line-independent generation makes vertical evidence cleaner.
   */
  function aggregatePath(C, S, w, h, D, ux, uy, P1, P2, weight) {
    // `weight` must be an integer: S is a Uint16Array, so `S[k] += 1.5 * L`
    // truncates on every store and biases the vertical paths downward. Callers
    // pass pre-scaled integers (see WEIGHT_SCALE).
    weight = Math.max(1, Math.round(weight));
    var Lprev = new Uint16Array(D);
    var Lcur = new Uint16Array(D);
    var BIG = 65000;

    // Every pixel whose predecessor (x-ux, y-uy) is outside the image is a
    // path start; walking from each covers the plane exactly once.
    var starts = [];
    var x, y;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var px = x - ux, py = y - uy;
        if (px < 0 || px >= w || py < 0 || py >= h) starts.push(x, y);
      }
    }

    for (var s = 0; s < starts.length; s += 2) {
      x = starts[s]; y = starts[s + 1];
      var first = true, minPrev = 0;

      while (x >= 0 && x < w && y >= 0 && y < h) {
        var base = ((y * w) + x) * D;
        var minCur = BIG, k;

        if (first) {
          for (k = 0; k < D; k++) {
            var c0 = C[base + k];
            Lcur[k] = c0;
            if (c0 < minCur) minCur = c0;
          }
          first = false;
        } else {
          var capped = minPrev + P2;
          for (k = 0; k < D; k++) {
            var m = capped;
            var a = Lprev[k];                                   if (a < m) m = a;
            if (k > 0)     { a = Lprev[k - 1] + P1;             if (a < m) m = a; }
            if (k < D - 1) { a = Lprev[k + 1] + P1;             if (a < m) m = a; }
            var v = C[base + k] + m - minPrev;
            Lcur[k] = v;
            if (v < minCur) minCur = v;
          }
        }

        for (k = 0; k < D; k++) {
          S[base + k] += weight * Lcur[k];
          Lprev[k] = Lcur[k];
        }
        minPrev = minCur;

        x += ux; y += uy;
      }
    }
  }

  /* ------------------------------------- 5. winner-take-all + confidence */

  /**
   * Winner-take-all with parabolic sub-pixel refinement, plus a best/second-best
   * uniqueness ratio. Low ratio => the pixel is aliased (d vs d+/-T), sitting on
   * a generator "echo" (a transitively-implied match with no surface behind it),
   * or in texture-poor carrier. Those get rejected and inpainted.
   */
  function selectDisparity(S, w, h, D, dMin, uniqueness, supported) {
    var disp = new Float32Array(w * h);
    var conf = new Float32Array(w * h);

    for (var i = 0, n = w * h; i < n; i++) {
      if (supported && !supported[i]) { disp[i] = NaN; conf[i] = 0; continue; }
      var base = i * D;
      var best = Infinity, bestK = -1, worst = -Infinity, k, v;
      for (k = 0; k < D; k++) {
        v = S[base + k];
        if (v < best) { best = v; bestK = k; }
        if (v > worst) worst = v;
      }
      // second best, excluding the immediate neighbourhood of the winner
      var second = Infinity;
      for (k = 0; k < D; k++) {
        if (k >= bestK - 1 && k <= bestK + 1) continue;
        v = S[base + k];
        if (v < second) second = v;
      }

      // Confidence = the winner's margin as a fraction of this pixel's own
      // cost spread.
      //
      // The textbook ratio test (1 - best/second) is useless here: census costs
      // hit exactly 0 on a correct match, and best/second is then 0 whatever
      // `second` is, so every matched pixel scores 1.0 -- including pixels where
      // a rival disparity ALSO costs ~0. That is exactly the case we must catch,
      // because a carrier with its own internal sub-period (a regularly
      // textured tile, common in real Magic Eyes) makes several disparities in
      // the search range fit perfectly. Normalising by (worst - best) gives an
      // absolute scale reference instead:
      //   unique match -> second is near `worst`  -> margin ~ 1  -> accept
      //   exact tie    -> second is near `best`   -> margin ~ 0  -> reject
      var ratio;
      if (second === Infinity) ratio = 1;                 // no rival at all (D <= 3)
      else if (worst <= best) ratio = 0;                  // wholly flat cost curve
      else ratio = (second - best) / (worst - best);
      if (ratio < 0) ratio = 0; else if (ratio > 1) ratio = 1;
      conf[i] = ratio;

      if (bestK <= 0 || bestK >= D - 1 || ratio < uniqueness) {
        disp[i] = NaN;
        continue;
      }
      // parabola through (bestK-1, bestK, bestK+1)
      var c1 = S[base + bestK - 1], c2 = S[base + bestK], c3 = S[base + bestK + 1];
      var den = (c1 - 2 * c2 + c3);
      var sub = den !== 0 ? (0.5 * (c1 - c3)) / den : 0;
      if (!(sub > -1 && sub < 1)) sub = 0;
      disp[i] = dMin + bestK + sub;
    }
    return { disp: disp, conf: conf };
  }

  /* -------------------------------------------------- 6. post-processing */

  /** Median of valid neighbours in a (2r+1)^2 window; removes salt-and-pepper
   *  without rounding off silhouettes the way a blur would. */
  function medianFilter(src, w, h, r) {
    var out = new Float32Array(src.length);
    var buf = new Float32Array((2 * r + 1) * (2 * r + 1));
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        if (isNaN(src[i])) { out[i] = NaN; continue; }
        var n = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= w) continue;
            var v = src[yy * w + xx];
            if (!isNaN(v)) buf[n++] = v;
          }
        }
        if (n === 0) { out[i] = NaN; continue; }
        var sub = buf.subarray(0, n);
        sub.sort();
        out[i] = sub[n >> 1];
      }
    }
    return out;
  }

  /** Reject connected components smaller than minArea (speckle), where
   *  "connected" means within `tol` disparity of the neighbour. */
  function removeSpeckles(disp, w, h, minArea, tol) {
    var seen = new Uint8Array(w * h);
    var stack = new Int32Array(w * h);
    var comp = new Int32Array(w * h);
    for (var start = 0; start < w * h; start++) {
      if (seen[start] || isNaN(disp[start])) continue;
      var sp = 0, cn = 0;
      stack[sp++] = start; seen[start] = 1;
      while (sp > 0) {
        var p = stack[--sp];
        comp[cn++] = p;
        var px = p % w, py = (p - px) / w, v = disp[p];
        for (var t = 0; t < 4; t++) {
          var nx = px + (t === 0 ? 1 : t === 1 ? -1 : 0);
          var ny = py + (t === 2 ? 1 : t === 3 ? -1 : 0);
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          var q = ny * w + nx;
          if (seen[q] || isNaN(disp[q])) continue;
          if (Math.abs(disp[q] - v) > tol) continue;
          seen[q] = 1; stack[sp++] = q;
        }
      }
      if (cn < minArea) for (var c = 0; c < cn; c++) disp[comp[c]] = NaN;
    }
    return disp;
  }

  /**
   * Fill rejected/unsupported pixels.
   *
   * A fixed number of diffusion passes cannot cross the uninformative border,
   * which is ~dMax/2 columns wide and can be hundreds of pixels at working
   * resolution. So do an O(N) bidirectional nearest-valid fill per row first
   * (distance-weighted where both sides exist, edge-replicating where only one
   * does), then the same vertically for any fully-empty rows, and only then a
   * few smoothing passes over the filled pixels to avoid a visible seam.
   */
  function fillHoles(disp, w, h, smoothIters) {
    var cur = Float32Array.from(disp);
    var wasHole = new Uint8Array(cur.length);
    var i, x, y;
    for (i = 0; i < cur.length; i++) if (isNaN(cur[i])) wasHole[i] = 1;

    var lv = new Float32Array(w), ld = new Float32Array(w);
    var rv = new Float32Array(w), rd = new Float32Array(w);
    var INF = Infinity;

    // --- stage 1: isotropic diffusion, for small interior holes.
    // Cheap, and better than a directional fill for isolated rejected pixels
    // (a purely horizontal interpolation smears across features). Bounded
    // passes, so it cannot cross the wide border -- stage 2 handles that.
    for (var dit = 0; dit < 12; dit++) {
      var changed = 0;
      var nx2 = Float32Array.from(cur);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          if (!isNaN(cur[i])) continue;
          var s2 = 0, c2 = 0;
          for (var t2 = 0; t2 < 4; t2++) {
            var ax = x + (t2 === 0 ? 1 : t2 === 1 ? -1 : 0);
            var ay = y + (t2 === 2 ? 1 : t2 === 3 ? -1 : 0);
            if (ax < 0 || ax >= w || ay < 0 || ay >= h) continue;
            var av = cur[ay * w + ax];
            if (!isNaN(av)) { s2 += av; c2++; }
          }
          if (c2) { nx2[i] = s2 / c2; changed++; }
        }
      }
      cur = nx2;
      if (!changed) break;
    }

    // --- stage 2: horizontal bidirectional fill
    for (y = 0; y < h; y++) {
      var row = y * w;
      var haveV = NaN, haveAt = -1;
      for (x = 0; x < w; x++) {
        var v = cur[row + x];
        if (!isNaN(v)) { haveV = v; haveAt = x; }
        lv[x] = haveV; ld[x] = haveAt < 0 ? INF : (x - haveAt);
      }
      haveV = NaN; haveAt = -1;
      for (x = w - 1; x >= 0; x--) {
        var v2 = cur[row + x];
        if (!isNaN(v2)) { haveV = v2; haveAt = x; }
        rv[x] = haveV; rd[x] = haveAt < 0 ? INF : (haveAt - x);
      }
      for (x = 0; x < w; x++) {
        if (!isNaN(cur[row + x])) continue;
        var dl = ld[x], dr = rd[x];
        if (dl === INF && dr === INF) continue;              // row has no data
        else if (dl === INF) cur[row + x] = rv[x];
        else if (dr === INF) cur[row + x] = lv[x];
        else cur[row + x] = (lv[x] * dr + rv[x] * dl) / (dl + dr);
      }
    }

    // --- vertical fill for any row that had nothing at all
    var cv = new Float32Array(h), cd = new Float32Array(h);
    var dv = new Float32Array(h), dd = new Float32Array(h);
    for (x = 0; x < w; x++) {
      var hv = NaN, hat = -1;
      for (y = 0; y < h; y++) {
        var a = cur[y * w + x];
        if (!isNaN(a)) { hv = a; hat = y; }
        cv[y] = hv; cd[y] = hat < 0 ? INF : (y - hat);
      }
      hv = NaN; hat = -1;
      for (y = h - 1; y >= 0; y--) {
        var b = cur[y * w + x];
        if (!isNaN(b)) { hv = b; hat = y; }
        dv[y] = hv; dd[y] = hat < 0 ? INF : (hat - y);
      }
      for (y = 0; y < h; y++) {
        if (!isNaN(cur[y * w + x])) continue;
        var du = cd[y], db = dd[y];
        if (du === INF && db === INF) continue;
        else if (du === INF) cur[y * w + x] = dv[y];
        else if (db === INF) cur[y * w + x] = cv[y];
        else cur[y * w + x] = (cv[y] * db + dv[y] * du) / (du + db);
      }
    }

    // --- soften the filled region only, so the seam is not visible
    var iters = smoothIters || 0;
    for (var it = 0; it < iters; it++) {
      var next = Float32Array.from(cur);
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          if (!wasHole[i]) continue;
          var sum = 0, n = 0;
          for (var t = 0; t < 4; t++) {
            var nx = x + (t === 0 ? 1 : t === 1 ? -1 : 0);
            var ny = y + (t === 2 ? 1 : t === 3 ? -1 : 0);
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            var q = cur[ny * w + nx];
            if (!isNaN(q)) { sum += q; n++; }
          }
          if (n) next[i] = (sum + cur[i]) / (n + 1);
        }
      }
      cur = next;
    }

    // --- anything still unfilled (image had no valid pixel at all)
    var vals = [];
    for (i = 0; i < cur.length; i++) if (!isNaN(cur[i])) vals.push(cur[i]);
    var med = vals.length ? vals.sort(function (a2, b2) { return a2 - b2; })[vals.length >> 1] : 0;
    for (i = 0; i < cur.length; i++) if (isNaN(cur[i])) cur[i] = med;
    return cur;
  }

  /**
   * Alignment correction.
   *
   * A disparity estimate at position p comes from the pixel pair
   * (p - d/2, p + d/2). Which of those the generator considered "the" position
   * of the depth sample depends on the generator:
   *
   *   symmetric (canonical SIRDS) : depth sampled at the midpoint p  -> shift 0
   *   asymmetric left-to-right    : depth sampled at p + d/2         -> shift +0.5
   *   asymmetric right-to-left    : depth sampled at p - d/2         -> shift -0.5
   *
   * There is no reliable way to tell from the image alone which was used, so
   * the midpoint is the default: it is exact for symmetric generators and
   * splits the error for asymmetric ones. `shift` is in units of local
   * disparity and is exposed to the user.
   */
  function alignField(field, disp, w, h, shift) {
    if (!shift) return field;
    var out = new Float32Array(field.length);
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var src = x - shift * disp[row + x];
        if (src < 0) src = 0; else if (src > w - 1) src = w - 1;
        var x0 = Math.floor(src), x1 = Math.min(w - 1, x0 + 1), t = src - x0;
        out[row + x] = field[row + x0] * (1 - t) + field[row + x1] * t;
      }
    }
    return out;
  }

  /* --------------------------------------------- 7. disparity -> depth map */

  /**
   * Invert the generator's separation function.
   *
   *   s(Z) = (1 - mu*Z) * E / (2 - mu*Z),  Z in [0,1], 0 = far, 1 = near
   *   =>  Z = (E - 2s) / (mu * (E - s)),   with E = 2T
   *
   * This corrects the generator's non-linearity: linear disparity is NOT linear
   * depth, and the difference is a visible bowing of flat surfaces. Note s
   * decreases as the surface approaches the viewer, so near => bright.
   */
  function disparityToDepth(disp, period, mu, linearise) {
    var out = new Float32Array(disp.length);

    // Self-calibrate the eye separation from the solution rather than trusting
    // the autocorrelation estimate: physically far = E/2 is the LARGEST
    // separation, so E = 2*max(d). Using a high percentile instead of the true
    // max keeps a few outliers from skewing the whole mapping. This makes the
    // linearisation robust to a slightly-off period estimate, which would
    // otherwise drive (E - 2s) negative and flip the depth sign.
    // NaN-safe: Float32Array.sort() puts NaN last, so a single NaN in the tail
    // would make the p98 lookup return NaN and poison E -- and with it every
    // output pixel. Collect finite values only.
    var finite = [];
    for (var f = 0; f < disp.length; f++) if (isFinite(disp[f])) finite.push(disp[f]);
    finite.sort(function (a, b) { return a - b; });
    var dHi = finite.length
      ? finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.98))]
      : period;
    var E = 2 * Math.max(dHi, period * 0.5);

    for (var i = 0; i < disp.length; i++) {
      var s = disp[i];
      if (linearise) {
        if (s > E / 2) s = E / 2;          // clamp beyond the far plane
        var den = mu * (E - s);
        out[i] = Math.abs(den) < 1e-6 ? 0 : (E - 2 * s) / den;
      } else {
        out[i] = -s; // relative: smaller separation = nearer = brighter
      }
    }
    return out;
  }

  /** Robust percentile stretch to [0,1]. Min/max would let a few outliers
   *  crush the whole dynamic range. */
  function normalise(v, loPct, hiPct) {
    var n = v.length;
    var out = new Float32Array(n);
    // Percentiles over finite values only (see disparityToDepth).
    var finite = [];
    for (var j = 0; j < n; j++) if (isFinite(v[j])) finite.push(v[j]);
    if (!finite.length) { out.fill(0.5); return out; }
    finite.sort(function (a, b) { return a - b; });
    var m = finite.length;
    var lo = finite[Math.max(0, Math.floor(m * loPct))];
    var hi = finite[Math.min(m - 1, Math.floor(m * hiPct))];
    var range = hi - lo;
    if (range < 1e-9) { out.fill(0.5); return out; }
    for (var i = 0; i < n; i++) {
      if (!isFinite(v[i])) { out[i] = 0.5; continue; }
      var t = (v[i] - lo) / range;
      out[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    return out;
  }

  /* ------------------------------------------------------------- pipeline */

  var DEFAULTS = {
    maxPixels: 260000,   // working resolution budget
    paths: 4,            // 4 or 8
    P1: 3,               // penalty for +/-1 disparity change (gentle slopes)
    P2: 26,              // penalty for larger jumps (truncation -> keeps edges)
    verticalWeight: 2,   // anisotropy: vertical evidence is cleaner
    uniqueness: 0.01,    // winner's margin as a fraction of the pixel's cost spread
    mu: 1 / 3,           // generator depth-of-field constant
    linearise: true,
    medianRadius: 2,
    speckleArea: 48,
    rangeLo: 0.60,       // search [rangeLo*T, rangeHi*T]; d/T in [2(1-mu)/(2-mu), 1]
    rangeHi: 1.10,
    period: 0,           // 0 = auto
    alignShift: 0,       // 0 = midpoint, +0.5 asymmetric L->R, -0.5 R->L
    invert: false
  };

  /**
   * solve(rgba, w, h, options, onProgress) -> {
   *   depth: Float32Array in [0,1] at working resolution,
   *   width, height, disparity, confidence, period, dMin, dMax, meta
   * }
   */
  function solve(rgba, w, h, options, onProgress) {
    var o = {};
    for (var key in DEFAULTS) o[key] = DEFAULTS[key];
    if (options) for (key in options) if (options[key] !== undefined && options[key] !== null) o[key] = options[key];

    var MIN_W = 64, MIN_H = 16;
    if (!(w > 0 && h > 0)) throw new Error('Image has no pixels.');
    if (w < MIN_W || h < MIN_H) {
      throw new Error('Image is too small to contain a stereogram (' + w + '\u00d7' + h +
        '; needs at least ' + MIN_W + '\u00d7' + MIN_H + ').');
    }

    var warnings = [];
    var report = onProgress || function () {};
    report(0.01, 'Analysing carrier pattern');

    // --- period estimate at (capped) native resolution ------------------
    var estW = w, estH = h, estData = rgba;
    if (w > 1400) {
      estW = 1400; estH = Math.max(1, Math.round(h * (1400 / w)));
      estData = resampleRGBA(rgba, w, h, estW, estH);
    }
    var grayEst = toGray(estData, estW, estH);
    var pe = estimatePeriod(grayEst, estW, estH, { mu: o.mu });
    var periodNative = (o.period > 0 ? o.period : pe.period * (w / estW));

    // --- choose working scale so that w*h*D fits the budget --------------
    // D ~ (rangeHi-rangeLo)*T*scale, so cost ~ scale^3.
    var Dnative = Math.max(6, Math.round((o.rangeHi - o.rangeLo) * periodNative));
    var budget = o.maxPixels * 64; // pixels * disparities
    var scale = Math.min(1, Math.cbrt(budget / (w * h * Dnative)));
    scale = Math.min(scale, Math.sqrt(o.maxPixels / (w * h)));
    // Never upscale, and never shrink below the minimum usable size.
    scale = Math.max(scale, Math.max(MIN_W / w, MIN_H / h));
    scale = Math.min(scale, 1);
    var W = Math.max(MIN_W, Math.min(w, Math.round(w * scale)));
    var H = Math.max(MIN_H, Math.min(h, Math.round(h * scale)));

    // The MIN_W/MIN_H floor above can override the memory budget on extreme
    // aspect ratios (a 64x100000 strip keeps full height). Cap the cost volume
    // explicitly rather than trying to allocate ~1 GB.
    var VOLUME_CAP = 40e6;                       // pixel-disparities => ~120 MB
    var estD = Math.max(6, Math.round((o.rangeHi - o.rangeLo) * periodNative * (W / w)));
    if (W * H * estD > VOLUME_CAP) {
      var allowedH = Math.floor(VOLUME_CAP / (W * estD));
      if (allowedH >= MIN_H) {
        H = allowedH;
      } else {
        throw new Error('Image is too large to process at this aspect ratio (' + w +
          '\u00d7' + h + '). Crop it to the stereogram itself and retry.');
      }
    }

    var work = resampleRGBA(rgba, w, h, W, H);
    var period = Math.max(6, periodNative * (W / w));

    // Widest searchable disparity given the census border.
    var dLimit = W - 2 * CENSUS_R - 2;
    // Physically d/T >= 2(1-mu)/(2-mu). With a large mu the near plane sits
    // below the default rangeLo, and the near end of the scene would be
    // silently clipped -- so widen the search to cover it.
    var physLo = 2 * (1 - o.mu) / (2 - o.mu);
    var rangeLo = Math.min(o.rangeLo, Math.max(0.3, physLo - 0.05));
    var dMin = Math.max(4, Math.round(rangeLo * period));
    var dMax = Math.max(dMin + 4, Math.round(o.rangeHi * period));
    if (dMax > dLimit) dMax = dLimit;
    if (dMax - dMin < 2) {
      dMin = Math.max(4, Math.min(dMin, dMax - 2));   // try shrinking dMin
      if (dMax - dMin < 2) {
        throw new Error('Image is too narrow for its carrier period (' + W +
          'px wide, period \u2248' + Math.round(period) + 'px). Crop to the stereogram itself and retry.');
      }
    }

    report(0.08, 'Census transform');
    var cR = censusChannel(work, W, H, 0);
    var cG = censusChannel(work, W, H, 1);
    var cB = censusChannel(work, W, H, 2);

    report(0.15, 'Building cost volume');
    var cv = buildCostVolume(cR, cG, cB, W, H, dMin, dMax, function (f) {
      report(0.15 + 0.25 * f, 'Building cost volume');
    });
    var C = cv.C, D = cv.D;

    report(0.40, 'Semi-global aggregation');
    var S = new Uint16Array(W * H * D);
    var paths = o.paths >= 8 ? PATHS_8 : PATHS_4;
    // Scale weights to integers so a fractional verticalWeight (the UI slider
    // steps by 0.5) is represented exactly rather than truncated per store.
    var WEIGHT_SCALE = 2;
    for (var pi = 0; pi < paths.length; pi++) {
      var ux = paths[pi][0], uy = paths[pi][1];
      var weight = (ux === 0)
        ? Math.round(o.verticalWeight * WEIGHT_SCALE)
        : WEIGHT_SCALE;
      aggregatePath(C, S, W, H, D, ux, uy, o.P1, o.P2, weight);
      report(0.40 + 0.40 * ((pi + 1) / paths.length), 'Semi-global aggregation');
    }

    report(0.82, 'Selecting disparities');
    var sel = selectDisparity(S, W, H, D, dMin, o.uniqueness, cv.supported);
    var disp = sel.disp;

    report(0.88, 'Filtering');
    disp = medianFilter(disp, W, H, o.medianRadius);
    disp = removeSpeckles(disp, W, H, o.speckleArea, 1.5);
    disp = fillHoles(disp, W, H, 6);

    report(0.95, 'Reconstructing depth');
    if (o.alignShift) disp = alignField(disp, disp, W, H, o.alignShift);
    var depthRaw = disparityToDepth(disp, period, o.mu, o.linearise);
    var depth = normalise(depthRaw, 0.02, 0.98);
    if (o.invert) for (var i = 0; i < depth.length; i++) depth[i] = 1 - depth[i];

    // fraction of *informative* pixels that survived the uniqueness test
    var kept = 0, sup = 0;
    for (i = 0; i < sel.disp.length; i++) {
      if (cv.supported[i]) { sup++; if (!isNaN(sel.disp[i])) kept++; }
    }

    // --- informative region ---------------------------------------------
    // The generator skips its constraint whenever left < 0 or right >= width,
    // so roughly dMax/2 columns at each edge encode no depth whatsoever. Those
    // are extrapolated, not recovered, and callers should be able to say so.
    var x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (var yy = 0; yy < H; yy++) {
      for (var xx = 0; xx < W; xx++) {
        if (cv.supported[yy * W + xx]) {
          if (xx < x0) x0 = xx;
          if (xx > x1) x1 = xx;
          if (yy < y0) y0 = yy;
          if (yy > y1) y1 = yy;
        }
      }
    }
    var informative = (x1 >= x0 && y1 >= y0)
      ? { x0: x0, x1: x1, y0: y0, y1: y1 }
      : { x0: 0, x1: W - 1, y0: 0, y1: H - 1 };

    // --- quality diagnostics --------------------------------------------
    // Gate on whether a band was actually found and how strong the peak is.
    // An SNR test against the median-|ncc| noise floor misfires on blurred or
    // low-contrast scans: blur raises correlation at *every* lag, inflating the
    // floor, so a perfectly-located period still looked like noise.
    if (pe.strength < 0.04 || !pe.bandCount) {
      warnings.push('No clear repeating carrier pattern was found. This may not be an ' +
        'autostereogram, or it may be cropped/rescaled. Try setting the period manually.');
    }
    if (sup === 0) {
      warnings.push('No pixels had full disparity support \u2014 the image is too narrow ' +
        'relative to its carrier period.');
    } else if (kept / sup < 0.35) {
      warnings.push('Only ' + Math.round(100 * kept / sup) + '% of pixels produced a confident ' +
        'match, so most of this result is interpolated. Try a different period or a lower ' +
        'uniqueness threshold.');
    }
    if (o.period <= 0 && Math.abs(periodNative - pe.peakLag) > 0.3 * pe.peakLag) {
      warnings.push('The carrier period estimate is uncertain (' + Math.round(periodNative) +
        'px). If the result looks wrong, try setting it manually.');
    }

    report(1, 'Done');
    return {
      warnings: warnings,
      informative: informative,
      depth: depth,
      width: W,
      height: H,
      disparity: disp,
      confidence: sel.conf,
      period: period,
      periodNative: periodNative,
      dMin: dMin,
      dMax: dMax,
      meta: {
        scale: scale,
        rangeLo: rangeLo,
        periodStrength: pe.strength,
        periodNoise: pe.noise,
        bandLo: pe.bandLo,
        bandCount: pe.bandCount,
        peakLag: pe.peakLag,
        coverage: sup ? kept / sup : 0,
        supportedFraction: sup / sel.disp.length,
        paths: paths.length,
        disparities: D
      }
    };
  }

  root.MagicEyeSolver = {
    solve: solve,
    estimatePeriod: estimatePeriod,
    resampleRGBA: resampleRGBA,
    alignField: alignField,
    toGray: toGray,
    DEFAULTS: DEFAULTS
  };
})(typeof self !== 'undefined' ? self : this);
