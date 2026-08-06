// Preloaded with --require into a SCRATCH CacheLane instance only.
//
// Induces a genuine synchronous block of the Node event loop: a busy-wait, not
// a sleep. Nothing else in the process can run for the duration, which is
// exactly the failure mode of the July 31 incident (a Tiktoken WASM encoder
// rebuilt per prunable block, ~45.7 ms each, summing to seconds).
//
// This is what makes the test real. monitorEventLoopDelay() in metrics.ts
// samples actual loop delay, so a busy-wait is measured the same way the
// incident was; a setTimeout would yield the loop and measure nothing.
const STALL_MS = Number(process.env.STALL_MS || 6000);
const DELAY_MS = Number(process.env.STALL_AFTER_MS || 20000);

setTimeout(() => {
  const started = Date.now();
  process.stderr.write(`[stall-preload] blocking the event loop for ${STALL_MS}ms\n`);
  while (Date.now() - started < STALL_MS) {
    /* deliberately spinning — do not replace with a sleep */
  }
  process.stderr.write(`[stall-preload] released after ${Date.now() - started}ms\n`);
}, DELAY_MS);
