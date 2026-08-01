import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const maintenanceScriptPath = path.resolve("scripts/compact-runtime-databases.sh");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Harness {
  logPath: string;
  env: NodeJS.ProcessEnv;
}

function makeHarness(failAction = ""): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-maintenance-test-"));
  tempRoots.push(root);

  const binDir = path.join(root, "bin");
  const installDir = path.join(root, "runtime");
  const logPath = path.join(root, "commands.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(installDir, "node_modules", "better-sqlite3"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(installDir, "node_modules", "better-sqlite3", "package.json"),
    "{}\n",
  );

  const claudeDb = path.join(root, "claude.db");
  const litellmDb = path.join(root, "litellm.db");
  fs.writeFileSync(claudeDb, "fixture");
  fs.writeFileSync(litellmDb, "fixture");

  const fakeTool = path.join(binDir, "fake-tool");
  fs.writeFileSync(
    fakeTool,
    `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$CACHELANE_TEST_LOG"
case "$name" in
  systemctl)
    if [[ "$*" == *"show -p User --value"* ]]; then
      printf '%s\\n' ras
    fi
    ;;
  curl)
    if [[ "$CACHELANE_HEALTH_FAIL" == "1" ]]; then
      exit 22
    fi
    printf '%s\\n' '{"status":"ok","inflight":0}'
    ;;
  runuser)
    if [[ -n "$CACHELANE_TEST_FAIL_ACTION" && "$*" == *"$CACHELANE_TEST_FAIL_ACTION"* ]]; then
      exit 42
    fi
    ;;
esac
`,
    { mode: 0o755 },
  );

  for (const name of ["systemctl", "curl", "runuser"]) {
    fs.symlinkSync(fakeTool, path.join(binDir, name));
  }

  return {
    logPath,
    env: {
      ...process.env,
      CACHELANE_MAINTENANCE_TESTING: "1",
      CACHELANE_TEST_LOG: logPath,
      CACHELANE_TEST_FAIL_ACTION: failAction,
      CACHELANE_HEALTH_FAIL: "0",
      CACHELANE_SYSTEMCTL_BIN: path.join(binDir, "systemctl"),
      CACHELANE_CURL_BIN: path.join(binDir, "curl"),
      CACHELANE_RUNUSER_BIN: path.join(binDir, "runuser"),
      CACHELANE_NODE_BIN: "/usr/bin/node",
      CACHELANE_INSTALL: installDir,
      CACHELANE_SERVICE_USER: "ras",
      CACHELANE_CLAUDE_DB: claudeDb,
      CACHELANE_LITELLM_DB: litellmDb,
      CACHELANE_READY_TIMEOUT_SEC: "0",
    },
  };
}

function runWorker(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [maintenanceScriptPath, "--worker"], {
    env,
    encoding: "utf8",
  });
}

function readLog(logPath: string): string {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

describe("detached database maintenance worker", () => {
  it("restores both lanes and the timer when compaction fails", () => {
    const harness = makeHarness("CACHELANE_DB_ACTION=vacuum");
    const result = runWorker(harness.env);
    const log = readLog(harness.logPath);

    expect(result.status).not.toBe(0);
    expect(log).toContain("systemctl start cachelane-claude.service");
    expect(log).toContain("systemctl start cachelane-litellm.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.timer");
  });

  it("maintains one lane at a time and runs the final healthcheck", () => {
    const harness = makeHarness();
    const result = runWorker(harness.env);
    const log = readLog(harness.logPath);
    const lines = log.split("\n");
    const stopLines = lines.filter((line) => line.startsWith("systemctl stop"));

    expect(result.status).toBe(0);
    expect(stopLines).toContain("systemctl stop cachelane-claude.service");
    expect(stopLines).toContain("systemctl stop cachelane-litellm.service");
    expect(
      stopLines.every(
        (line) =>
          !(line.includes("cachelane-claude") && line.includes("cachelane-litellm")),
      ),
    ).toBe(true);
    expect(lines.indexOf("systemctl start cachelane-claude.service")).toBeLessThan(
      lines.indexOf("systemctl stop cachelane-litellm.service"),
    );
    expect(log).toContain("systemctl start cachelane-healthcheck.service");
  });
});
