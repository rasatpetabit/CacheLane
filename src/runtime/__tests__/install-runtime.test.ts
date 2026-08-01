import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const installerPath = path.resolve("scripts/install-runtime.sh");
const installer = fs.readFileSync(installerPath, "utf8");

describe("install-runtime restart safety", () => {
  it("installs the canonical tested healthcheck instead of generating a heredoc", () => {
    expect(installer).not.toContain("<<'HEALTH'");
    expect(installer).toContain(
      'sudo install -m 0755 "$REPO_ROOT/scripts/cachelane-healthcheck.sh" /usr/local/sbin/cachelane-healthcheck',
    );
  });

  it("preserves health failure counters between timer runs", () => {
    expect(installer).toContain("RuntimeDirectory=cachelane-healthcheck");
    expect(installer).toContain("RuntimeDirectoryPreserve=yes");
  });

  it("installs a fixed root-owned maintenance worker without inlining compaction", () => {
    expect(installer).toContain('rsync -a "$REPO_ROOT/scripts/" "$STAGE/scripts/"');
    expect(installer).toContain(
      'sudo install -o root -g root -m 0755 "$REPO_ROOT/scripts/compact-runtime-databases.sh" /usr/local/sbin/cachelane-compact-runtime-databases',
    );
    expect(installer).not.toContain("VACUUM");
  });

  it("waits for two idle samples before each lane restart", () => {
    expect(installer).toContain("wait_for_lane_drain()");
    expect(installer).toContain('CACHELANE_DRAIN_TIMEOUT_SEC:-300');
    expect(installer).toContain("idle_samples=0");
    expect(installer).toContain("idle_samples >= 2");

    const liteWait = installer.indexOf("wait_for_lane_drain 7332");
    const liteRestart = installer.indexOf("systemctl restart cachelane-litellm.service");
    const claudeWait = installer.indexOf("wait_for_lane_drain 7333");
    const claudeRestart = installer.indexOf("systemctl restart cachelane-claude.service");

    expect(claudeWait).toBeGreaterThan(-1);
    expect(claudeRestart).toBeGreaterThan(claudeWait);
    expect(liteWait).toBeGreaterThan(claudeRestart);
    expect(liteRestart).toBeGreaterThan(liteWait);
  });

  it("waits for a changed PID and healthy lane after each restart", () => {
    expect(installer).toContain("wait_for_lane_ready()");
    expect(installer).toContain('CACHELANE_READY_TIMEOUT_SEC:-30');
    expect(installer).toContain('"$new_pid" != "$old_pid"');
    expect(installer).toContain('"status":"ok"');
    expect(installer).not.toContain("sleep 1\n\"$NODE_BIN\" \"$INSTALL/scripts/health-dual.mjs\"");
  });

  it("fails deployment on drain timeout instead of forcing restart", () => {
    expect(installer).toContain("timed out waiting for active connections to drain");
    expect(installer).toContain("wait_for_lane_drain 7333 || exit 1");
    expect(installer).toContain("if ! wait_for_lane_drain 7332; then");
    expect(installer).toContain("LiteLLM remains on its prior process (split state)");
  });
});
