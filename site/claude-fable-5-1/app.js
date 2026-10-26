/* Magic Eye Solver — page logic. All work happens in this browser. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    dropzone: $('dropzone'), fileInput: $('file-input'), urlInput: $('url-input'), urlLoad: $('url-load'),
    loadStatus: $('load-status'), solveBtn: $('solve-btn'), cancelBtn: $('cancel-btn'),
    progress: $('progress'), progressFill: $('progress-fill'), progressText: $('progress-text'),
    resultCard: $('result-card'), canvas: $('view-canvas'), resultInfo: $('result-info'),
    periodCanvas: $('period-canvas'), periodInfo: $('period-info'), qualityNote: $('quality-note'),
    downloadBtn: $('download-btn'), downloadFullBtn: $('download-full-btn'), resetBtn: $('reset-btn'),
    opt: {
      maxWidth: $('opt-maxWidth'), periodMode: $('opt-periodMode'), period: $('opt-period'),
      nearFrac: $('opt-nearFrac'), farFrac: $('opt-farFrac'), window: $('opt-window'), method: $('opt-method'),
      paths: $('opt-paths'), p1: $('opt-p1'), p2: $('opt-p2'), median: $('opt-median'), invert: $('opt-invert'),
      stretch: $('opt-stretch'), colormap: $('opt-colormap')
    },
    out: { nearFrac: $('out-nearFrac'), farFrac: $('out-farFrac'), window: $('out-window'), p1: $('out-p1'), p2: $('out-p2') }
  };

  var state = {
    source: null,      // { rgba: Uint8ClampedArray, width, height, name, canvas }
    result: null,
    worker: null,
    jobId: 0,
    view: 'depth',
    busy: false,
    periodCursor: null
  };

  // ------------------------------------------------------------ settings ---
  var DEFAULT_UI = { maxWidth: '640', periodMode: 'auto', period: '', nearFrac: '35', farFrac: '15', window: '3', method: 'sgm', paths: '8', p1: '4', p2: '100', median: true, invert: false, stretch: true, colormap: 'gray' };

  function windowFromSlider(v) { return 2 * parseInt(v, 10) - 1; }

  function refreshOutputs() {
    els.out.nearFrac.textContent = els.opt.nearFrac.value + '%';
    els.out.farFrac.textContent = els.opt.farFrac.value + '%';
    els.out.window.textContent = windowFromSlider(els.opt.window.value) + ' px';
    els.out.p1.textContent = els.opt.p1.value;
    els.out.p2.textContent = els.opt.p2.value;
    els.opt.period.disabled = els.opt.periodMode.value !== 'manual';
  }

  function applyUiDefaults() {
    var o = els.opt;
    o.maxWidth.value = DEFAULT_UI.maxWidth; o.periodMode.value = DEFAULT_UI.periodMode; o.period.value = DEFAULT_UI.period;
    o.nearFrac.value = DEFAULT_UI.nearFrac; o.farFrac.value = DEFAULT_UI.farFrac; o.window.value = DEFAULT_UI.window;
    o.method.value = DEFAULT_UI.method; o.paths.value = DEFAULT_UI.paths; o.p1.value = DEFAULT_UI.p1; o.p2.value = DEFAULT_UI.p2;
    o.median.checked = DEFAULT_UI.median; o.invert.checked = DEFAULT_UI.invert; o.stretch.checked = DEFAULT_UI.stretch; o.colormap.value = DEFAULT_UI.colormap;
    refreshOutputs();
  }

  function readOptions() {
    var o = els.opt;
    var win = windowFromSlider(o.window.value);
    var period = 0;
    if (o.periodMode.value === 'manual') {
      period = parseFloat(o.period.value);
      if (!(period > 2)) period = 0;
    }
    return {
      maxWidth: parseInt(o.maxWidth.value, 10),
      period: period,
      nearFrac: parseInt(o.nearFrac.value, 10) / 100,
      farFrac: parseInt(o.farFrac.value, 10) / 100,
      windowW: win, windowH: win,
      method: o.method.value,
      paths: parseInt(o.paths.value, 10),
      p1: parseFloat(o.p1.value),
      p2: parseFloat(o.p2.value),
      median: o.median.checked,
      invert: o.invert.checked,
      stretch: o.stretch.checked
    };
  }

  // --------------------------------------------------------- image input ---
  function setStatus(msg, kind) {
    els.loadStatus.textContent = msg || '';
    els.loadStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  var MAX_SOURCE_DIM = 4096;

  function imageDataFromBitmap(bmp, name) {
    var w = bmp.width, h = bmp.height;
    var k = Math.max(w, h) > MAX_SOURCE_DIM ? MAX_SOURCE_DIM / Math.max(w, h) : 1;
    var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, cw, ch);
    var id = ctx.getImageData(0, 0, cw, ch);
    if (bmp.close) bmp.close();
    return { rgba: id.data, width: cw, height: ch, name: name || 'image', canvas: c };
  }

  function decodeBlob(blob, name) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).then(function (bmp) { return imageDataFromBitmap(bmp, name); });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); try { resolve(imageDataFromBitmap(img, name)); } catch (e) { reject(e); } };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
      img.src = url;
    });
  }

  function loadBlob(blob, name) {
    if (!blob) return;
    setStatus('Reading image…');
    decodeBlob(blob, name).then(function (src) {
      setSource(src);
    }).catch(function (err) {
      setStatus('Could not read that as an image (' + (err && err.message ? err.message : 'unknown error') + ').', 'error');
    });
  }

  function loadUrl(url) {
    url = (url || '').trim();
    if (!url) return;
    if (!/^(https?:|data:image\/|blob:)/i.test(url)) { setStatus('Please enter an http(s) image URL (or a data: image URL).', 'error'); return; }
    if (/^http:/i.test(url) && location.protocol === 'https:') { setStatus('This page is served over https, so browsers block plain http: images. Use an https link, or save the picture and drop it here.', 'error'); return; }
    setStatus('Fetching image…');
    fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      if (!r.ok) throw new Error('server answered ' + r.status);
      return r.blob();
    }).then(function (b) {
      var name = url.split('?')[0].split('#')[0].split('/').pop() || 'image';
      return decodeBlob(b, name);
    }).then(setSource).catch(function (err) {
      setStatus('Could not load that URL. The site may not allow browsers to read the image directly (' + (err && err.message ? err.message : 'blocked') + '). Save the picture and drop the file here instead.', 'error');
    });
  }

  function setSource(src) {
    if (state.busy) abortJob();
    state.source = src;
    state.result = null;
    setStatus('Loaded ' + src.name + ' (' + src.width + ' × ' + src.height + ').', 'ok');
    els.solveBtn.disabled = false;
    els.resultCard.hidden = true;
    solve();
  }

  // Sample stereograms generated on the fly.
  function textDepth(w, h, text) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold ' + Math.round(h * 0.55) + 'px Arial, Helvetica, sans-serif';
    ctx.fillText(text, w / 2, h / 2);
    var d = ctx.getImageData(0, 0, w, h).data, Z = new Float32Array(w * h);
    for (var i = 0; i < Z.length; i++) Z[i] = d[i * 4] > 128 ? 0.8 : 0;
    return Z;
  }

  function loadSample(kind) {
    if (!window.Stereogram) { setStatus('Sample generator unavailable.', 'error'); return; }
    var w = 800, h = 520, G = window.Stereogram, Z, opts = { E: 200 };
    var seed = (Date.now() & 0xffff) | 1;
    if (kind === 'sphere') { Z = G.depthSphere(w, h); opts.pattern = G.makePattern(100, 100, seed); }
    else if (kind === 'torus') { Z = G.depthTorus(w, h); opts.pattern = G.makePattern(100, 100, seed + 1); }
    else if (kind === 'text') { Z = textDepth(w, h, 'HELLO'); opts.pattern = G.makePattern(100, 100, seed + 2); }
    else { Z = G.depthSphere(w, h); opts.color = true; opts.seed = seed; }
    var g = G.generate(Z, w, h, opts);
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var id = ctx.createImageData(w, h); id.data.set(g.rgba); ctx.putImageData(id, 0, 0);
    setSource({ rgba: id.data, width: w, height: h, name: 'sample-' + kind + '.png', canvas: c });
  }

  // ------------------------------------------------------------- solving ---
  function workerSource() {
    var body = function () {
      self.onmessage = function (e) {
        var m = e.data;
        try {
          var res = MagicEyeSolver.solve(m.rgba, m.width, m.height, m.options, function (stage, frac) {
            self.postMessage({ id: m.id, type: 'progress', stage: stage, frac: frac });
          });
          var transfer = [res.disparity.buffer, res.depth.buffer, res.confidence.buffer, res.curve.buffer, res.valid.buffer, res.observable.buffer];
          if (res.occluded) transfer.push(res.occluded.buffer);
          self.postMessage({ id: m.id, type: 'done', result: res }, transfer);
        } catch (err) {
          self.postMessage({ id: m.id, type: 'error', message: String(err && err.message || err) });
        }
      };
    };
    return 'var MagicEyeSolver = (' + window.__magicEyeSolverFactory.toString() + ')();\n(' + body.toString() + ')();';
  }

  function getWorker() {
    if (state.worker) return state.worker;
    try {
      var url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
      var wk = new Worker(url);
      URL.revokeObjectURL(url);
      state.worker = wk;
      return wk;
    } catch (e) {
      return null;
    }
  }

  function setProgress(stage, frac) {
    els.progress.hidden = false;
    els.progressFill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    els.progressText.textContent = stage + (frac > 0 ? ' ' + Math.round(frac * 100) + '%' : '…');
  }

  function setBusy(b) {
    state.busy = b;
    els.solveBtn.disabled = b || !state.source;
    els.cancelBtn.hidden = !b;
    if (!b) els.progress.hidden = true;
  }

  var WATCHDOG_MS = 45000;
  var watchdog = null;

  function armWatchdog(id) {
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      if (state.jobId !== id || !state.busy) return;
      abortJob();
      setStatus('The solver stopped responding (probably out of memory). Try a smaller processing width or a narrower search range.', 'error');
    }, WATCHDOG_MS);
  }

  // Stop whatever job is running; the next solve() gets a fresh worker.
  function abortJob() {
    state.jobId++;
    clearTimeout(watchdog);
    if (state.worker) { try { state.worker.terminate(); } catch (_) { /* ignore */ } state.worker = null; }
    setBusy(false);
  }

  function deviceCellBudget() {
    var mem = navigator.deviceMemory;   // GiB, Chromium only; undefined elsewhere
    if (mem && mem <= 2) return 20e6;
    if (mem && mem <= 4) return 40e6;
    return 80e6;
  }

  function solve() {
    if (!state.source) return;
    if (state.busy) abortJob();          // a newer request always wins
    var opts = readOptions();
    opts.maxCells = deviceCellBudget();
    var id = ++state.jobId;
    var src = state.source;
    setBusy(true);
    setProgress('Starting', 0);
    els.qualityNote.hidden = true;
    var finish = function (fn) { if (state.jobId !== id || state.source !== src) return; clearTimeout(watchdog); setBusy(false); fn(); };
    var wk = getWorker();
    if (wk) {
      wk.onmessage = function (e) {
        var m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress') { setProgress(m.stage, m.frac); armWatchdog(id); }
        else if (m.type === 'done') finish(function () { showResult(m.result); });
        else if (m.type === 'error') finish(function () { setStatus('Solve failed: ' + m.message, 'error'); });
      };
      wk.onerror = function (e) {
        finish(function () {
          setStatus('Solver crashed: ' + (e.message || 'unknown error') + '. Try a smaller processing width.', 'error');
          try { wk.terminate(); } catch (_) { /* ignore */ }
          state.worker = null;
        });
      };
      armWatchdog(id);
      // copy so the page keeps its own pixels
      var copy = new Uint8ClampedArray(src.rgba);
      wk.postMessage({ id: id, rgba: copy, width: src.width, height: src.height, options: opts }, [copy.buffer]);
    } else {
      setTimeout(function () {
        try {
          var res = window.MagicEyeSolver.solve(src.rgba, src.width, src.height, opts, null);
          finish(function () { showResult(res); });
        } catch (err) { finish(function () { setStatus('Solve failed: ' + err.message, 'error'); }); }
      }, 20);
    }
  }

  function cancel() {
    abortJob();
    setStatus('Cancelled.');
  }

  // Invert / contrast stretch are pure post-processing of the separation map.
  function rederiveDepth() {
    var r = state.result; if (!r || !window.MagicEyeSolver) return;
    var d = window.MagicEyeSolver.toDepthImage(r.disparity, r.valid, r.width, r.height, r.sMin, r.sMax, els.opt.invert.checked, els.opt.stretch.checked);
    r.depth = d.depth; r.depthLo = d.lo; r.depthHi = d.hi;
    r.options.invert = els.opt.invert.checked; r.options.stretch = els.opt.stretch.checked;
    render();
  }

  // ----------------------------------------------------------- rendering ---
  var COLORMAPS = {
    gray: null,
    viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
    inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4']
  };
  var lutCache = {};
  function lut(name) {
    if (lutCache[name]) return lutCache[name];
    var stops = COLORMAPS[name], out = new Uint8Array(256 * 3);
    for (var i = 0; i < 256; i++) {
      if (!stops) { out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = i; continue; }
      var t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
      var a = hex(stops[k]), b = hex(stops[k + 1]);
      out[i * 3] = Math.round(a[0] + (b[0] - a[0]) * f); out[i * 3 + 1] = Math.round(a[1] + (b[1] - a[1]) * f); out[i * 3 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    }
    lutCache[name] = out; return out;
  }
  function hex(s) { return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]; }

  function paintGray(canvas, values, w, h, mapName) {
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true }), id = ctx.createImageData(w, h), d = id.data, L = lut(mapName || 'gray');
    for (var i = 0, j = 0; i < values.length; i++, j += 4) {
      var v = values[i] * 3; d[j] = L[v]; d[j + 1] = L[v + 1]; d[j + 2] = L[v + 2]; d[j + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  function render() {
    var r = state.result; if (!r) return;
    if (state.view === 'depth') paintGray(els.canvas, r.depth, r.width, r.height, els.opt.colormap.value);
    else if (state.view === 'confidence') paintGray(els.canvas, r.confidence, r.width, r.height, 'gray');
    else {
      els.canvas.width = r.width; els.canvas.height = r.height;
      var ctx = els.canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(state.source.canvas, 0, 0, r.width, r.height);
    }
  }

  function fmt(x, d) { return Number(x).toFixed(d === undefined ? 1 : d); }

  function showResult(r) {
    state.result = r;
    els.resultCard.hidden = false;
    render();
    drawPeriod(r);
    var scaleNote = r.scale > 1.001 ? ' (shrunk ' + fmt(1 / r.scale, 2) + '×)' : '';
    els.resultInfo.textContent = 'Processed at ' + r.width + ' × ' + r.height + scaleNote + '. Repeats searched ' + r.sMin + '–' + r.sMax + ' px. Took ' + fmt(r.timing.total / 1000, 1) + ' s.';
    els.periodInfo.textContent = fmt(r.period, 1) + ' px' + (r.scale > 1.001 ? ' (' + fmt(r.periodOriginal, 1) + ' px in the original)' : '') + (r.options.period > 0 ? ', set manually' : ', auto-detected');
    // quality hints
    var notes = [];
    var c = r.candidates || [];
    if (r.options.period <= 0 && c.length > 1) {
      // Harmonics (2x, 3x) of the chosen period are expected; any other strong notch is a real alternative.
      var maxProm = c[0].prominence, alt = null;
      for (var ci = 0; ci < c.length; ci++) {
        var cd = c[ci], ratio = cd.lag / r.period, k = Math.round(ratio);
        var harmonic = k >= 1 && k <= 3 && Math.abs(ratio - k) < 0.1;
        var insideBand = cd.lag >= r.sMin && cd.lag <= r.sMax;   // a notch inside the search band is just another surface
        if (!harmonic && !insideBand && cd.prominence >= 0.7 * maxProm) { alt = cd; break; }
      }
      if (alt) notes.push('The pattern repeat is ambiguous: there is another strong notch at ' + fmt(alt.lag * r.scale, 0) + ' px' + (r.scale > 1.001 ? ' in the original' : '') + '. If the result looks wrong, click that notch below.');
    }
    var sum = 0, n = 0;
    for (var i = 0; i < r.confidence.length; i += 7) { sum += r.confidence[i]; n++; }
    var meanConf = sum / n / 255;
    if (meanConf < 0.25) notes.push('Match confidence is low overall. This may not be an autostereogram, or it may be heavily compressed; try a larger matching window or a different processing width.');
    if (r.depthHi - r.depthLo < 2 && r.options.stretch) notes.push('Almost no depth variation was found; the picture may be flat, or the period may be wrong.');
    if (r.options.period <= 0 && (r.period <= r.minLag + 2 || r.period >= r.maxLag - 2)) notes.push('The detected repeat sits at the edge of the range auto-detect can see (' + fmt(r.minLag * r.scale, 0) + '–' + fmt(r.maxLag * r.scale, 0) + ' px). If the picture looks wrong, set the period manually.');
    if (r.bandExtendedTo) notes.push('A weaker repeat was found at ' + fmt(r.bandExtendedTo * r.scale, 0) + ' px, above the detected period; the search was widened to include it in case that is the real background.');
    if (r.clippedFraction > 0.08) notes.push(fmt(100 * r.clippedFraction, 0) + '% of the picture hit the edge of the search range. Widen the “nearer” or “farther” range if the depth looks flattened.');
    els.qualityNote.textContent = notes.join(' ');
    els.qualityNote.hidden = notes.length === 0;
    if (state.source && !els.loadStatus.classList.contains('error')) setStatus('Loaded ' + state.source.name + ' (' + state.source.width + ' × ' + state.source.height + ').', 'ok');
  }

  function drawPeriod(r) {
    var cv = els.periodCanvas, dpr = window.devicePixelRatio || 1;
    var cssW = cv.clientWidth || 600, cssH = 110;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    var ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    var curve = r.curve, lo = Infinity, hi = -Infinity, first = -1, last = -1;
    for (var L = 0; L < curve.length; L++) { var v = curve[L]; if (v !== v) continue; if (first < 0) first = L; last = L; if (v < lo) lo = v; if (v > hi) hi = v; }
    var css = getComputedStyle(document.documentElement);
    var line = css.getPropertyValue('--line').trim() || '#ddd', accent = css.getPropertyValue('--accent').trim() || '#2f6fed', text = css.getPropertyValue('--muted').trim() || '#666';
    ctx.clearRect(0, 0, cssW, cssH);
    cv._map = null;
    if (first < 0 || last <= first) { ctx.fillStyle = text; ctx.fillText('No curve', 8, 20); return; }
    var padL = 6, padR = 6, padT = 8, padB = 18, pw = cssW - padL - padR, ph = cssH - padT - padB;
    var X = function (lag) { return padL + (lag - first) / (last - first) * pw; };
    var Y = function (v) { return padT + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * ph; };
    // candidate ticks
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    (r.candidates || []).forEach(function (cd) { ctx.beginPath(); ctx.moveTo(X(cd.lag), padT); ctx.lineTo(X(cd.lag), padT + ph); ctx.stroke(); });
    // curve
    ctx.strokeStyle = text; ctx.lineWidth = 1.5; ctx.beginPath();
    for (L = first; L <= last; L++) { var y = Y(curve[L]); if (L === first) ctx.moveTo(X(L), y); else ctx.lineTo(X(L), y); }
    ctx.stroke();
    // chosen period
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X(r.period), padT); ctx.lineTo(X(r.period), padT + ph); ctx.stroke();
    // search band
    ctx.fillStyle = accent; ctx.globalAlpha = 0.12; ctx.fillRect(X(r.sMin), padT, X(r.sMax) - X(r.sMin), ph); ctx.globalAlpha = 1;
    // axis labels
    ctx.fillStyle = text; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top';
    ctx.textAlign = 'left'; ctx.fillText(fmt(first * r.scale, 0) + ' px', padL, padT + ph + 4);
    ctx.textAlign = 'right'; ctx.fillText(fmt(last * r.scale, 0) + ' px', padL + pw, padT + ph + 4);
    ctx.textAlign = 'center'; ctx.fillText('shift (pixels in the original image)', padL + pw / 2, padT + ph + 4);
    // keyboard cursor
    if (state.periodCursor !== null && state.periodCursor >= first && state.periodCursor <= last) {
      ctx.strokeStyle = text; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(state.periodCursor), padT); ctx.lineTo(X(state.periodCursor), padT + ph); ctx.stroke(); ctx.setLineDash([]);
    }
    cv._map = { first: first, last: last, padL: padL, pw: pw, cssW: cssW };
  }

  function applyPeriodLag(lag) {
    var r = state.result, m = els.periodCanvas._map; if (!r || !m) return;
    lag = Math.max(m.first, Math.min(m.last, lag));
    // snap to the nearest local minimum within a few pixels
    var best = Math.round(lag), bestV = r.curve[best];
    for (var k = Math.max(m.first, best - 4); k <= Math.min(m.last, best + 4); k++) if (r.curve[k] < bestV) { bestV = r.curve[k]; best = k; }
    els.opt.periodMode.value = 'manual';
    els.opt.period.value = fmt(best * r.scale, 1);
    refreshOutputs();
    state.periodCursor = null;
    solve();
  }

  function periodClick(ev) {
    var m = els.periodCanvas._map; if (!m) return;
    var rect = els.periodCanvas.getBoundingClientRect();
    var x = (ev.clientX - rect.left) * (m.cssW / rect.width);
    applyPeriodLag(m.first + (x - m.padL) / m.pw * (m.last - m.first));
  }

  // Keyboard: arrows step through the notches, Enter applies, Escape clears.
  function periodKey(ev) {
    var r = state.result, m = els.periodCanvas._map; if (!r || !m) return;
    var lags = (r.candidates || []).map(function (c) { return c.lag; }).sort(function (a, b) { return a - b; });
    if (!lags.length) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      var cur = state.periodCursor === null ? Math.round(r.period) : state.periodCursor, next = null;
      if (ev.key === 'ArrowRight') { for (var i = 0; i < lags.length; i++) if (lags[i] > cur) { next = lags[i]; break; } }
      else { for (var j = lags.length - 1; j >= 0; j--) if (lags[j] < cur) { next = lags[j]; break; } }
      if (next !== null) { state.periodCursor = next; drawPeriod(r); els.periodInfo.textContent = fmt(r.period, 1) + ' px; candidate ' + fmt(next * r.scale, 0) + ' px selected, press Enter to use it'; }
    } else if (ev.key === 'Enter' && state.periodCursor !== null) { ev.preventDefault(); applyPeriodLag(state.periodCursor); }
    else if (ev.key === 'Escape') { state.periodCursor = null; drawPeriod(r); }
  }

  // ----------------------------------------------------------- downloads ---
  function download(canvas, filename) {
    var done = function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    };
    if (canvas.toBlob) canvas.toBlob(done, 'image/png');
    else { var s = atob(canvas.toDataURL('image/png').split(',')[1]), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); done(new Blob([b], { type: 'image/png' })); }
  }
  function baseName() { return (state.source && state.source.name ? state.source.name.replace(/\.[^.]+$/, '') : 'stereogram') + '-depth'; }
  function depthCanvas() {
    var r = state.result, c = document.createElement('canvas');
    paintGray(c, r.depth, r.width, r.height, els.opt.colormap.value);
    return c;
  }
  function downloadDepth() { if (state.result) download(depthCanvas(), baseName() + '.png'); }
  function downloadFull() {
    if (!state.result) return;
    var r = state.result, src = state.source, c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    var ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(depthCanvas(), 0, 0, r.width, r.height, 0, 0, src.width, src.height);
    download(c, baseName() + '-' + src.width + 'x' + src.height + '.png');
  }

  // -------------------------------------------------------------- wiring ---
  els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
  els.dropzone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } });
  els.fileInput.addEventListener('change', function () { if (els.fileInput.files[0]) loadBlob(els.fileInput.files[0], els.fileInput.files[0].name); els.fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(function (t) { els.dropzone.addEventListener(t, function (e) { e.preventDefault(); els.dropzone.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { els.dropzone.addEventListener(t, function (e) { e.preventDefault(); els.dropzone.classList.remove('over'); }); });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    var dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files[0]) { loadBlob(dt.files[0], dt.files[0].name); return; }
    var uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).filter(function (l) { return l && l[0] !== '#'; })[0] || '';
    if (/^https?:/i.test(uri)) { els.urlInput.value = uri.trim(); loadUrl(uri); }
  });
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) { loadBlob(items[i].getAsFile(), 'pasted-image'); e.preventDefault(); return; }
    }
    var txt = e.clipboardData.getData('text');
    if (txt && /^https?:\S+$/i.test(txt.trim()) && document.activeElement !== els.urlInput) { els.urlInput.value = txt.trim(); loadUrl(txt); }
  });
  els.urlLoad.addEventListener('click', function () { loadUrl(els.urlInput.value); });
  els.urlInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadUrl(els.urlInput.value); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-sample]'), function (b) { b.addEventListener('click', function () { loadSample(b.getAttribute('data-sample')); }); });
  els.solveBtn.addEventListener('click', solve);
  els.cancelBtn.addEventListener('click', cancel);
  els.resetBtn.addEventListener('click', function () { applyUiDefaults(); if (state.source) solve(); });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t, i, all) {
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var n = (i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length;
      all[n].focus(); all[n].click();
    });
  });
  Object.keys(els.opt).forEach(function (k) { els.opt[k].addEventListener('input', refreshOutputs); });
  els.opt.colormap.addEventListener('change', render);
  els.opt.invert.addEventListener('change', rederiveDepth);
  els.opt.stretch.addEventListener('change', rederiveDepth);
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      state.view = t.getAttribute('data-view');
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (o) { var on = o === t; o.classList.toggle('active', on); o.setAttribute('aria-selected', on ? 'true' : 'false'); });
      render();
    });
  });
  els.periodCanvas.addEventListener('click', periodClick);
  els.periodCanvas.addEventListener('keydown', periodKey);
  els.downloadBtn.addEventListener('click', downloadDepth);
  els.downloadFullBtn.addEventListener('click', downloadFull);
  window.addEventListener('resize', function () { if (state.result) drawPeriod(state.result); });

  applyUiDefaults();
  // ?sample=sphere|torus|text|dots loads a generated sample on open (handy for demos and smoke tests).
  var qs = /[?&]sample=([a-z]+)/.exec(location.search);
  if (qs) loadSample(qs[1]);
})();
