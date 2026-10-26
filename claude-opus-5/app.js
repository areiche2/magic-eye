/* ============================================================================
   app.js — UI, image loading, worker orchestration, rendering.
   No dependencies. The only network request the page ever makes is an image
   URL the user explicitly types.
   ========================================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var QUALITY = {
    fast:     { maxPixels: 120000, paths: 4 },
    balanced: { maxPixels: 260000, paths: 4 },
    best:     { maxPixels: 450000, paths: 8 }
  };

  var state = {
    rgba: null, width: 0, height: 0, name: '',
    result: null, busy: false, worker: null, workerOk: null,
    truth: null,            // ground-truth depth when generated in-page
    truthW: 0, truthH: 0,
    pendingResolve: false,
    // Bumped whenever the loaded image changes or a new solve starts. A result
    // whose token is stale is discarded, so loading image B while A is still
    // solving can't paint A's depth map at B's dimensions (or score A against
    // B's ground truth).
    gen: 0
  };

  /* ------------------------------------------------------------- messages */

  function clearMessages() { $('messages').innerHTML = ''; }

  function message(kind, html) {
    var d = document.createElement('div');
    d.className = 'msg ' + kind;
    d.innerHTML = html;
    $('messages').appendChild(d);
  }

  function setStatus(text) { $('status').textContent = text; }
  function setProgress(f) { $('progBar').style.width = Math.round(f * 100) + '%'; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -------------------------------------------------------- image loading */

  function showSource() {
    var hold = $('srcHold');
    hold.innerHTML = '';
    var c = document.createElement('canvas');
    c.width = state.width; c.height = state.height;
    c.getContext('2d').putImageData(new ImageData(
      new Uint8ClampedArray(state.rgba), state.width, state.height), 0, 0);
    hold.appendChild(c);
    $('srcMeta').textContent = state.width + '×' + state.height +
      (state.name ? ' · ' + state.name : '');
    $('solveBtn').disabled = false;
  }

  function adoptImageData(rgba, w, h, name, truth) {
    state.gen++;                 // invalidate anything already in flight
    state.pendingResolve = false;
    state.busy = false;
    state.rgba = rgba; state.width = w; state.height = h; state.name = name || '';
    state.truth = truth || null; state.truthW = truth ? w : 0; state.truthH = truth ? h : 0;
    state.result = null;
    $('downloadBtn').disabled = true;
    $('outHold').innerHTML = '<div class="empty">Nothing solved yet</div>';
    $('outMeta').textContent = '';
    $('diag').innerHTML = '';
    clearMessages();
    showSource();
    setStatus('Ready to solve');
    setProgress(0);
  }

  function loadFromImage(img, name) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) { message('err', 'That image reported zero dimensions.'); return; }
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var data;
    try {
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      message('err', '<strong>The browser blocked reading this image’s pixels.</strong> ' +
        'The server didn’t send permissive CORS headers, so the canvas is “tainted” and ' +
        'its data can’t be read. Save the image to disk and drop it in instead.');
      return;
    }
    adoptImageData(new Uint8ClampedArray(data), w, h, name, null);
    if (state.rgba.length && $('autoSolve').checked) solve();
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      message('err', 'That doesn’t look like an image file (' + escapeHtml(file.type || 'unknown type') + ').');
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { URL.revokeObjectURL(url); loadFromImage(img, file.name); };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      message('err', 'The browser couldn’t decode that image file.');
    };
    img.src = url;
  }

  function loadUrl(u) {
    u = (u || '').trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      message('err', 'Please give an http:// or https:// URL, or use the file picker.');
      return;
    }
    clearMessages();
    setStatus('Fetching image…');
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { setStatus('Ready to solve'); loadFromImage(img, u.split('/').pop()); };
    img.onerror = function () {
      setStatus('Load failed');
      message('err', '<strong>Couldn’t load that URL.</strong> Either it isn’t reachable, ' +
        'isn’t an image, or the server refuses cross-origin reads. ' +
        'Download the image and drop it in instead.');
    };
    img.src = u;
  }

  /* ------------------------------------------------------------ rendering */

  function depthToCanvas(depth, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var img = new ImageData(w, h);
    for (var i = 0, p = 0; i < depth.length; i++, p += 4) {
      var v = depth[i];
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      var g = (v * 255) | 0;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = g;
      img.data[p + 3] = 255;
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function showResult(res) {
    var small = depthToCanvas(res.depth, res.width, res.height);
    var inf = res.informative || { x0: 0, x1: res.width - 1, y0: 0, y1: res.height - 1 };
    var crop = $('crop').checked;

    // Which part of the estimate to present, and the output size it maps to.
    var sx = 0, sy = 0, sw = res.width, sh = res.height;
    var ow = state.width, oh = state.height;
    if (crop) {
      sx = inf.x0; sy = inf.y0;
      sw = inf.x1 - inf.x0 + 1; sh = inf.y1 - inf.y0 + 1;
      ow = Math.round(sw * state.width / res.width);
      oh = Math.round(sh * state.height / res.height);
    }

    // Present at (a multiple of) the source size so it lines up with the input.
    var big = document.createElement('canvas');
    big.width = Math.max(1, ow); big.height = Math.max(1, oh);
    var bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, sx, sy, sw, sh, 0, 0, big.width, big.height);

    var hold = $('outHold');
    hold.innerHTML = '';
    hold.appendChild(big);
    $('outMeta').textContent = 'estimated at ' + res.width + '\u00d7' + res.height +
      ', shown at ' + big.width + '\u00d7' + big.height + (crop ? ' (cropped)' : '');
    $('downloadBtn').disabled = false;
    state.resultCanvas = big;
  }

  function showDiagnostics(res) {
    var m = res.meta;
    var items = [
      ['Carrier period T', Math.round(res.periodNative) + ' px'],
      ['Disparity search', res.dMin + '–' + res.dMax + ' px (' + m.disparities + ' levels)'],
      ['Confident matches', Math.round(m.coverage * 100) + '%'],
      ['Informative area', Math.round(m.supportedFraction * 100) + '%'],
      ['Informative cols', (res.informative ? (res.informative.x0 + '-' + res.informative.x1) : '?') +
        ' of ' + res.width + ' (edges extrapolated)'],
      ['Aggregation paths', String(m.paths)],
      ['Working scale', (m.scale * 100).toFixed(0) + '%'],
      ['Autocorr. peak', m.periodStrength.toFixed(3) + ' (noise ' + m.periodNoise.toFixed(3) + ')'],
      ['Solve time', res.elapsed + ' ms']
    ];
    $('diag').innerHTML = items.map(function (kv) {
      return '<div><dt>' + escapeHtml(kv[0]) + '</dt><dd>' + escapeHtml(kv[1]) + '</dd></div>';
    }).join('');
  }

  /* ------------------------------------------------------- option gathering */

  function options() {
    var q = QUALITY[$('quality').value] || QUALITY.balanced;
    var lo = parseFloat($('searchLo').value);
    return {
      maxPixels: q.maxPixels,
      paths: q.paths,
      P2: parseInt($('smooth').value, 10),
      P1: Math.max(1, Math.round(parseInt($('smooth').value, 10) / 8)),
      verticalWeight: parseFloat($('vweight').value),
      uniqueness: parseFloat($('uniq').value),
      mu: parseFloat($('mu').value),
      linearise: $('linearise').checked,
      invert: $('invert').checked,
      alignShift: parseFloat($('align').value),
      rangeLo: lo,
      rangeHi: 1.10,
      period: $('periodMode').value === 'manual' ? parseInt($('periodVal').value, 10) || 0 : 0
    };
  }

  /* ---------------------------------------------------------------- solve */

  function ensureWorker() {
    if (state.workerOk !== null) return state.worker;
    try {
      state.worker = new Worker('worker.js');
      state.workerOk = true;
    } catch (e) {
      state.worker = null;
      state.workerOk = false;
    }
    $('engineBadge').textContent = 'engine: ' + (state.workerOk ? 'web worker' : 'main thread');
    return state.worker;
  }

  function finishSolve(res, t0, gen) {
    if (gen !== undefined && gen !== state.gen) return;   // stale: image changed
    res.elapsed = Date.now() - t0;
    state.result = res;
    state.busy = false;
    $('solveBtn').disabled = false;
    setProgress(1);
    setStatus('Solved in ' + res.elapsed + ' ms');
    showResult(res);
    showDiagnostics(res);
    if (res.warnings && res.warnings.length) {
      message('warn', '<strong>Heads up:</strong><ul>' +
        res.warnings.map(function (w) { return '<li>' + escapeHtml(w) + '</li>'; }).join('') +
        '</ul>');
    }
    if (state.truth) scoreAgainstTruth(res);
    if (state.pendingResolve) { state.pendingResolve = false; solve(); }
  }

  function failSolve(msg, gen) {
    if (gen !== undefined && gen !== state.gen) return;   // stale
    state.busy = false;
    state.pendingResolve = false;     // don't let a failure queue a phantom solve
    $('solveBtn').disabled = false;
    setProgress(0);
    setStatus('Failed');
    message('err', '<strong>Couldn’t solve this image.</strong> ' + escapeHtml(msg));
  }

  function solve() {
    if (!state.rgba) return;
    if (state.busy) { state.pendingResolve = true; return; }
    state.busy = true;
    $('solveBtn').disabled = true;
    clearMessages();
    setProgress(0.02);
    setStatus('Solving…');

    var opts = options();
    var t0 = Date.now();
    var myGen = state.gen;
    var w = ensureWorker();

    if (w) {
      w.onmessage = function (e) {
        var m = e.data;
        // Compare the token the worker echoed, NOT one captured here: this
        // handler is replaced on every solve, so it also receives messages
        // belonging to earlier jobs.
        if (m.gen !== state.gen) return;                   // stale job
        if (m.type === 'progress') { setProgress(m.frac); setStatus(m.label + '…'); }
        else if (m.type === 'done') finishSolve(m, t0, m.gen);
        else if (m.type === 'error') failSolve(m.message, m.gen);
      };
      w.onerror = function (err) {
        // Worker died (most often a file:// origin restriction) — fall back.
        state.workerOk = false; state.worker = null;
        $('engineBadge').textContent = 'engine: main thread';
        try { err.preventDefault(); } catch (e) {}
        state.busy = false;
        solveSync(t0, opts, myGen);
      };
      // Copy: the worker transfers buffers back, and we keep the source intact.
      var copy = new Uint8ClampedArray(state.rgba);
      w.postMessage({ rgba: copy, width: state.width, height: state.height,
        options: opts, gen: myGen }, [copy.buffer]);
    } else {
      // Yield once so the spinner/status actually paints before we block.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { solveSync(t0, opts, myGen); });
      });
    }
  }

  function solveSync(t0, opts, myGen) {
    if (myGen !== undefined && myGen !== state.gen) return;
    state.busy = true;
    $('solveBtn').disabled = true;
    try {
      var res = self.MagicEyeSolver.solve(
        state.rgba, state.width, state.height, opts,
        function (f, label) { setProgress(f); }
      );
      finishSolve(res, t0, myGen);
    } catch (err) {
      failSolve(err && err.message ? err.message : String(err), myGen);
    }
  }

  /* -------------------------------------------------- generator / self-test */

  function genOptions() {
    return {
      E: parseInt($('genE').value, 10),
      mu: parseFloat($('genMu').value),
      colour: $('genColour').checked,
      seed: 20260915
    };
  }

  function generateExample(runSolve) {
    var G = self.MagicEyeGenerator;
    var w = 620, h = 460;
    var Z = G.scene($('scene').value, w, h);
    var rgba = G.generate(Z, w, h, genOptions());
    adoptImageData(rgba, w, h, 'example: ' + $('scene').value, Z);
    $('testResult').innerHTML = '';
    if (runSolve) solve();
  }

  /** Pearson correlation between the recovered depth and the known truth,
   *  resampled to the estimate's resolution. Also tries the inverted map,
   *  because overall sign is a gauge choice, not an error. */
  function scoreAgainstTruth(res) {
    var w = res.width, h = res.height, n = w * h;
    var gt = new Float32Array(n);
    for (var y = 0; y < h; y++) {
      var sy = Math.min(state.truthH - 1, Math.round(y * state.truthH / h));
      for (var x = 0; x < w; x++) {
        var sx = Math.min(state.truthW - 1, Math.round(x * state.truthW / w));
        gt[y * w + x] = state.truth[sy * state.truthW + sx];
      }
    }
    function corr(a) {
      var ma = 0, mb = 0, i;
      for (i = 0; i < n; i++) { ma += a[i]; mb += gt[i]; }
      ma /= n; mb /= n;
      var sab = 0, saa = 0, sbb = 0;
      for (i = 0; i < n; i++) {
        var da = a[i] - ma, db = gt[i] - mb;
        sab += da * db; saa += da * da; sbb += db * db;
      }
      return sab / (Math.sqrt(saa * sbb) || 1);
    }
    var inv = new Float32Array(n);
    for (var j = 0; j < n; j++) inv[j] = 1 - res.depth[j];
    var c1 = corr(res.depth), c2 = corr(inv);
    var c = Math.max(c1, c2);
    var verdict = c > 0.9 ? 'excellent' : c > 0.75 ? 'good' : c > 0.5 ? 'partial' : 'poor';
    var kind = c > 0.75 ? 'warn' : 'err';
    var el = $('testResult');
    el.innerHTML = '<div class="msg ' + (c > 0.75 ? 'warn' : 'err') + '" style="margin-top:14px">' +
      '<strong>Self-test: ' + verdict + '.</strong> Correlation with the known depth map: ' +
      '<code>' + c.toFixed(4) + '</code>' + (c2 > c1 ? ' (sign inverted — a gauge choice, not an error)' : '') +
      '. Confident matches: ' + Math.round(res.meta.coverage * 100) + '%.' +
      '</div>';
    if (c > 0.9) {
      el.firstChild.className = 'msg';
      el.firstChild.style.background = 'rgba(78,201,160,.1)';
      el.firstChild.style.border = '1px solid rgba(78,201,160,.3)';
      el.firstChild.style.color = 'var(--ok)';
    }
  }

  /* ------------------------------------------------------------- download */

  function download() {
    if (!state.resultCanvas) return;
    state.resultCanvas.toBlob(function (blob) {
      var a = document.createElement('a');
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = (state.name ? state.name.replace(/\.[^.]+$/, '') : 'magic-eye') + '-depth.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }, 'image/png');
  }

  /* ------------------------------------------------------------- wiring */

  function bindLive(id, fmt, target) {
    var el = $(id);
    var out = $(target || (id + 'v'));
    function upd() { if (out) out.textContent = fmt(el.value); }
    el.addEventListener('input', upd);
    upd();
    return el;
  }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function init() {
    // scene list
    var sel = $('scene');
    self.MagicEyeGenerator.sceneNames.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n; o.textContent = n.charAt(0).toUpperCase() + n.slice(1);
      sel.appendChild(o);
    });

    // live labels
    bindLive('smooth', function (v) { return v; });
    bindLive('vweight', function (v) { return parseFloat(v).toFixed(1); });
    bindLive('uniq', function (v) { return parseFloat(v).toFixed(2); });
    bindLive('mu', function (v) { return parseFloat(v).toFixed(2); });
    bindLive('genE', function (v) { return v + ' px'; });
    bindLive('genMu', function (v) { return parseFloat(v).toFixed(2); });
    bindLive('align', function (v) {
      var f = parseFloat(v);
      if (Math.abs(f) < 0.001) return 'centred';
      return (f > 0 ? '+' : '') + f.toFixed(2) + '×d';
    });
    bindLive('searchLo', function (v) { return parseFloat(v).toFixed(2) + ' – 1.10 × T'; }, 'searchv');

    // file / drop / paste
    var drop = $('drop'), fileInput = $('file');
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () { loadFile(fileInput.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt.files && dt.files.length) { loadFile(dt.files[0]); return; }
      var uri = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (uri) { $('url').value = uri.trim(); loadUrl(uri); }
    });
    window.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          loadFile(items[i].getAsFile());
          e.preventDefault();
          return;
        }
      }
      // A URL is only fetched when it was pasted into the URL field itself.
      // Auto-fetching anything pasted anywhere on the page would make the
      // browser issue a request the user never asked for -- which would also
      // break this page's promise about when it touches the network.
      if (e.target === $('url')) {
        var txt = e.clipboardData.getData('text');
        if (txt && /^https?:\/\/\S+$/i.test(txt.trim())) {
          e.preventDefault();
          $('url').value = txt.trim();
          loadUrl(txt);
        }
      }
    });

    // url
    $('loadUrl').addEventListener('click', function () { loadUrl($('url').value); });
    $('url').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); loadUrl($('url').value); }
    });

    // period mode
    $('periodMode').addEventListener('change', function () {
      var manual = $('periodMode').value === 'manual';
      $('periodVal').disabled = !manual;
      if (manual && state.result && !parseInt($('periodVal').value, 10)) {
        $('periodVal').value = Math.round(state.result.periodNative);
      }
    });

    // actions
    $('solveBtn').addEventListener('click', solve);
    $('downloadBtn').addEventListener('click', download);
    $('genBtn').addEventListener('click', function () { generateExample($('autoSolve').checked); });
    $('selfTest').addEventListener('click', function () { generateExample(true); });

    $('resetBtn').addEventListener('click', function () {
      var d = self.MagicEyeSolver.DEFAULTS;
      $('quality').value = 'balanced';
      $('smooth').value = d.P2;
      $('vweight').value = d.verticalWeight;
      $('uniq').value = d.uniqueness;
      $('mu').value = d.mu;
      $('align').value = 0;
      $('searchLo').value = d.rangeLo;
      $('linearise').checked = d.linearise;
      $('invert').checked = false;
      $('crop').checked = false;
      $('periodMode').value = 'auto';
      $('periodVal').disabled = true;
      ['smooth', 'vweight', 'uniq', 'mu', 'align', 'searchLo'].forEach(function (id) {
        $(id).dispatchEvent(new Event('input'));
      });
      // The 'input' events dispatched above already schedule the debounced
      // re-solve, which reads every control fresh -- so one solve covers all of
      // them. Calling solve() here as well produced two solves per click.
    });

    // auto re-solve on setting change
    // No !state.busy guard: solve() queues via pendingResolve, so a slider
    // released during a long solve still gets applied. Guarding here silently
    // dropped the change and left the displayed result disagreeing with the UI.
    var reSolve = debounce(function () {
      if ($('autoSolve').checked && state.rgba) solve();
    }, 260);
    ['quality', 'smooth', 'vweight', 'uniq', 'mu', 'align', 'searchLo',
     'linearise', 'invert', 'periodMode', 'periodVal'].forEach(function (id) {
      $(id).addEventListener('change', reSolve);
    });
    ['smooth', 'vweight', 'uniq', 'mu', 'align', 'searchLo'].forEach(function (id) {
      $(id).addEventListener('input', reSolve);
    });

    $('crop').addEventListener('change', function () {
      if (state.result) showResult(state.result);   // pure re-render, no re-solve
    });

    ensureWorker();
    setStatus('Load an image to begin');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
