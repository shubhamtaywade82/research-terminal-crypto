// Event-loop lag monitor (diagnostic, opt-in with NPRS_DIAG=1).
//
// A 20 ms timer records how late it fires. A late timer means the event loop was
// blocked for that long (synchronous work, GC, or a native call that does not yield).
// Blocks above the threshold are logged with a wall-clock timestamp so they can be
// matched against ingest steps and against the requests that were waiting.

let started = false;

export function startLagMonitor(thresholdMs = 150): void {
  if (started) return;
  started = true;
  let last = performance.now();
  let worst = 0;
  setInterval(() => {
    const now = performance.now();
    const lag = now - last - 20;
    last = now;
    if (lag > worst) worst = lag;
    if (lag > thresholdMs) {
      console.log(`[lag] ${new Date().toISOString()} event loop blocked ${Math.round(lag)} ms`);
    }
  }, 20).unref();
  setInterval(() => {
    if (worst > 0) console.log(`[lag] worst in last 10 s: ${Math.round(worst)} ms`);
    worst = 0;
  }, 10_000).unref();
}
