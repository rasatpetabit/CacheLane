import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Point the whole run at a throwaway CACHELANE_HOME.
 *
 * The suite used to inherit the ambient environment, so `vitest run` on a machine
 * also running the proxy wrote into the *live* lane's log and touched its real DB
 * path. That contaminated the production log with test output from 258 PIDs and
 * 1,992 `listening` events — badly enough that a later forensic pass chased a
 * phantom "request leak" which was nothing but unsegmented test noise.
 *
 * This is computed here, at config evaluation, because the config is evaluated
 * exactly once in the main process. Handing the path to the workers via
 * `test.env` means it is set before any test module is imported — which matters,
 * since `src/logger` builds its singleton at import time and a `beforeEach` would
 * already be too late. Tests that set CACHELANE_HOME themselves are unaffected;
 * this only replaces the inherited default.
 */
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-vitest-"));
process.env.CACHELANE_VITEST_HOME = TEST_HOME; // read by the teardown hook

export default defineConfig({
  test: {
    globals: false,
    passWithNoTests: true,
    // `.worktrees/**`: a git worktree is a separate checkout carrying its own
    // copy of the suite. Running it from here executed a stale duplicate of
    // every test — 81 extra files — against this tree's node_modules, doubling
    // the runtime and reporting results for code that is not the code under
    // test. Those tests belong to that checkout and should run from inside it.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/**",
      "**/.worktrees/**",
    ],
    env: { CACHELANE_HOME: TEST_HOME },
    globalSetup: ["./vitest.globalSetup.ts"],
  },
});
