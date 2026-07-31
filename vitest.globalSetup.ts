import fs from "node:fs";

/**
 * Removes the throwaway CACHELANE_HOME created in vitest.config.ts.
 *
 * `globalSetup` runs once per run in the main process — unlike `setupFiles`,
 * which is evaluated once per test *file*. That distinction is the whole reason
 * this file exists: an earlier version created the directory and registered its
 * cleanup from `setupFiles`, which produced one temp directory per test file (86
 * of them on this suite) and never removed any, because vitest tears workers
 * down without running their `exit` handlers.
 */
export function setup() {
  // The directory is created in vitest.config.ts so its path can be handed to
  // the workers through `test.env` before any of them start.
}

export function teardown() {
  const home = process.env.CACHELANE_VITEST_HOME;
  if (!home) return;
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // Best effort — a leftover temp directory is harmless, and throwing here
    // would fail an otherwise-green run.
  }
}
