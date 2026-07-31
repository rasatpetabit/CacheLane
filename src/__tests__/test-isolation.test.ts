import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { cachelaneHome } from "../cli/paths.js";

/**
 * Guard for vitest.setup.ts.
 *
 * The suite used to inherit the ambient CACHELANE_HOME, so `vitest run` on a
 * machine also running the proxy wrote test output into the live lane's log and
 * touched its real DB path. That contaminated the production log badly enough
 * that a later forensic pass chased a phantom "request leak" which turned out to
 * be test noise from 258 interleaved PIDs.
 *
 * If the setup file stops being applied — renamed, dropped from the config, or
 * shadowed by a project-level override — these fail immediately rather than
 * quietly resuming writes to real operational state.
 */
describe("test isolation", () => {
  it("CACHELANE_HOME is set for the run", () => {
    expect(process.env.CACHELANE_HOME).toBeTruthy();
  });

  it("resolves under the OS temp dir, never the real home", () => {
    const home = cachelaneHome();
    // Not a string prefix check: with tmpdir "/tmp", the path "/tmp-other"
    // shares the prefix while living somewhere else entirely. Containment is a
    // question about path segments, so ask path.relative.
    const rel = path.relative(os.tmpdir(), home);
    expect(rel).not.toBe("");
    expect(path.isAbsolute(rel)).toBe(false);
    expect(rel.split(path.sep)).not.toContain("..");
    expect(home).not.toBe(path.join(os.homedir(), ".cachelane"));
  });

  it("is not any of the deployed lane homes", () => {
    // The two production homes, plus the symlink that points at the first.
    const deployed = [".cachelane", ".cachelane-claude", ".cachelane-litellm"].map((d) =>
      path.join(os.homedir(), d),
    );
    expect(deployed).not.toContain(cachelaneHome());
  });
});
