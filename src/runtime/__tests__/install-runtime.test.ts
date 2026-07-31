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

  it("fails deployment on drain timeout instead of forcing restart", () => {
    expect(installer).toContain("timed out waiting for active connections to drain");
    expect(installer).toContain("wait_for_lane_drain 7333 || exit 1");
    expect(installer).toContain("if ! wait_for_lane_drain 7332; then");
    expect(installer).toContain("LiteLLM remains on its prior process (split state)");
  });
});
