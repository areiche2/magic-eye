/* Web Worker wrapper. Keeps the UI responsive when the page is served over
   http(s). Chrome refuses to load worker scripts from file:// (opaque origin),
   so app.js falls back to running the solver synchronously in that case. */
importScripts('solver.js');

self.onmessage = function (e) {
  var m = e.data;
  // `gen` is the caller's job token, echoed back on every message. The page
  // reassigns onmessage per solve, so a token captured in the handler closure
  // would be the NEW job's token while an older job's message is still in
  // flight -- the stale result would be accepted. Echoing it makes the check
  // per-message instead of per-handler.
  var gen = m.gen;
  try {
    var res = self.MagicEyeSolver.solve(
      m.rgba, m.width, m.height, m.options,
      function (frac, label) {
        self.postMessage({ type: 'progress', frac: frac, label: label, gen: gen });
      }
    );
    self.postMessage({
      type: 'done',
      gen: gen,
      depth: res.depth,
      disparity: res.disparity,
      confidence: res.confidence,
      width: res.width,
      height: res.height,
      period: res.period,
      periodNative: res.periodNative,
      dMin: res.dMin,
      dMax: res.dMax,
      meta: res.meta,
      informative: res.informative,
      warnings: res.warnings
    }, [res.depth.buffer, res.disparity.buffer, res.confidence.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', gen: gen, message: err && err.message ? err.message : String(err) });
  }
};
