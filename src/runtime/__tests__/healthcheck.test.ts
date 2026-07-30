import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/cachelane-healthcheck.sh");

let tmpDir: string;
let binDir: string;
let stateDir: string;
let systemctlLog: string;
let loggerLog: string;

function executable(name: string, body: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function runHealth(overrides: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      CACHELANE_HEALTHCHECK_STATE_DIR: stateDir,
      CACHELANE_HEALTHCHECK_FAILURE_THRESHOLD: "3",
      CACHELANE_HEALTHCHECK_PROBE_TIMEOUT: "1",
      CACHELANE_HEALTHCHECK_RECHECK_DELAY: "0",
      SYSTEMCTL_LOG: systemctlLog,
      LOGGER_LOG: loggerLog,
      CURL_FAIL_PORTS: "",
      SS_ACTIVE_PORTS: "",
      INACTIVE_SERVICES: "",
      ...overrides,
    },
  });
  expect(result.stderr, result.stderr).toBe("");
  return result;
}

function failureCount(service: string): string | null {
  const file = path.join(stateDir, `${service}.failures`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-healthcheck-"));
  binDir = path.join(tmpDir, "bin");
  stateDir = path.join(tmpDir, "state");
  systemctlLog = path.join(tmpDir, "systemctl.log");
  loggerLog = path.join(tmpDir, "logger.log");
  fs.mkdirSync(binDir);

  executable("systemctl", `
    echo "$*" >> "$SYSTEMCTL_LOG"
    if [[ "\${1:-}" == "is-active" ]]; then
      service="\${!#}"
      [[ " \${INACTIVE_SERVICES:-} " != *" $service "* ]]
      exit
    fi
  `);
  executable("curl", `
    args="$*"
    for port in \${CURL_FAIL_PORTS:-}; do
      [[ "$args" == *"127.0.0.1:$port/healthz"* ]] && exit 28
    done
    printf '{"status":"ok"}'
  `);
  executable("ss", `
    args="$*"
    for port in \${SS_ACTIVE_PORTS:-}; do
      if [[ "$args" == *":$port"* ]]; then
        echo "ESTAB 0 0 127.0.0.1:$port 127.0.0.1:50000"
      fi
    done
  `);
  executable("logger", `echo "$*" >> "$LOGGER_LOG"`);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cachelane-healthcheck", () => {
  it("does not restart after the first or second failed local probe", () => {
    expect(runHealth({ CURL_FAIL_PORTS: "7332" }).status).toBe(0);
    expect(failureCount("cachelane-litellm.service")).toBe("1");
    expect(runHealth({ CURL_FAIL_PORTS: "7332" }).status).toBe(0);
    expect(failureCount("cachelane-litellm.service")).toBe("2");
    expect(lines(systemctlLog).filter((line) => line.startsWith("restart "))).toEqual([]);
  });

  it("restarts once after the third failure when both connection checks are idle", () => {
    runHealth({ CURL_FAIL_PORTS: "7332" });
    runHealth({ CURL_FAIL_PORTS: "7332" });
    expect(runHealth({ CURL_FAIL_PORTS: "7332" }).status).toBe(0);

    expect(lines(systemctlLog).filter((line) => line === "restart cachelane-litellm.service")).toHaveLength(1);
    expect(failureCount("cachelane-litellm.service")).toBeNull();
  });

  it("never restarts at threshold while a LiteLLM client is connected", () => {
    runHealth({ CURL_FAIL_PORTS: "7332" });
    runHealth({ CURL_FAIL_PORTS: "7332" });
    expect(runHealth({ CURL_FAIL_PORTS: "7332", SS_ACTIVE_PORTS: "7332" }).status).toBe(0);

    expect(lines(systemctlLog).filter((line) => line.startsWith("restart "))).toEqual([]);
    expect(failureCount("cachelane-litellm.service")).toBe("3");
    expect(lines(loggerLog).join("\n")).toContain("restart deferred: active connections");
  });

  it("clears retained failure state after the local probe recovers", () => {
    runHealth({ CURL_FAIL_PORTS: "7332" });
    runHealth({ CURL_FAIL_PORTS: "7332" });
    runHealth({ CURL_FAIL_PORTS: "7332", SS_ACTIVE_PORTS: "7332" });

    expect(runHealth().status).toBe(0);
    expect(failureCount("cachelane-litellm.service")).toBeNull();
  });

  it("applies the active-client guard to the Claude lane", () => {
    runHealth({ CURL_FAIL_PORTS: "7333" });
    runHealth({ CURL_FAIL_PORTS: "7333" });
    expect(runHealth({ CURL_FAIL_PORTS: "7333", SS_ACTIVE_PORTS: "7333" }).status).toBe(0);

    expect(lines(systemctlLog).filter((line) => line.startsWith("restart "))).toEqual([]);
    expect(failureCount("cachelane-claude.service")).toBe("3");
  });

  it("starts an inactive service immediately", () => {
    expect(runHealth({ INACTIVE_SERVICES: "cachelane-litellm.service" }).status).toBe(0);
    expect(lines(systemctlLog)).toContain("start cachelane-litellm.service");
    expect(failureCount("cachelane-litellm.service")).toBeNull();
  });
});
