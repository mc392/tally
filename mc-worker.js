// Runs the range-of-outcomes simulation (analysis.js monteCarlo) off the main thread, so the screen stays responsive.
importScripts('model.js', 'curves.js', 'engine.js', 'analysis.js');
self.onmessage = e => {
  const { id, data, sk, opts } = e.data;
  try { self.postMessage({ id, result: TallyAnalysis.monteCarlo(data, sk, opts) }); }
  catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
