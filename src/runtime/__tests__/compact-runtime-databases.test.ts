import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const maintenanceScriptPath = path.resolve("scripts/compact-runtime-databases.sh");
const maintenanceScript = fs.readFileSync(maintenanceScriptPath, "utf8");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface Harness {
  logPath: string;
  env: NodeJS.ProcessEnv;
  databasePaths: string[];
  initialSizes: number[];
}

function createBloatedDatabase(databasePath: string): number {
  const database = new Database(databasePath);
  database.pragma("journal_mode = DELETE");
  database.exec("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
  const insert = database.prepare("INSERT INTO payloads (body) VALUES (?)");
  const payload = Buffer.alloc(8_192, "x");
  database.transaction(() => {
    for (let index = 0; index < 256; index += 1) insert.run(payload);
  })();
  database.exec("DELETE FROM payloads");
  database.close();
  return fs.statSync(databasePath).size;
}

function makeHarness(failAction = ""): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-maintenance-test-"));
  tempRoots.push(root);

  const binDir = path.join(root, "bin");
  const installDir = path.join(root, "runtime");
  const logPath = path.join(root, "commands.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(installDir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.resolve("node_modules/better-sqlite3"),
    path.join(installDir, "node_modules", "better-sqlite3"),
    "dir",
  );

  const claudeDb = path.join(root, "claude.db");
  const litellmDb = path.join(root, "litellm.db");
  const databasePaths = [claudeDb, litellmDb];
  const initialSizes = databasePaths.map(createBloatedDatabase);

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
    if [[ -n "$CACHELANE_INACTIVE_UNIT" && "$*" == *"is-active --quiet $CACHELANE_INACTIVE_UNIT"* ]]; then
      exit 3
    fi
    ;;
  curl)
    if [[ "$CACHELANE_HEALTH_FAIL" == "1" ]]; then
      exit 22
    fi
    printf '%s\\n%s\\n' '{"status":"ok","inflight":0}' "$CACHELANE_HEALTH_STATUS"
    ;;
  runuser)
    if [[ -n "$CACHELANE_TEST_FAIL_ACTION" && "$*" == *"$CACHELANE_TEST_FAIL_ACTION"* ]]; then
      exit 42
    fi
    while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
    [[ "$#" -gt 0 ]] && shift
    exec "$@"
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
    databasePaths,
    initialSizes,
    env: {
      ...process.env,
      CACHELANE_MAINTENANCE_TESTING: "1",
      CACHELANE_TEST_LOG: logPath,
      CACHELANE_TEST_FAIL_ACTION: failAction,
      CACHELANE_HEALTH_FAIL: "0",
      CACHELANE_HEALTH_STATUS: "200",
      CACHELANE_INACTIVE_UNIT: "",
      CACHELANE_LAUNCH_CAPTURE: "",
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
    expect(log).toContain("systemctl start cachelane-healthcheck.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.timer");
  });

  it("rejects inactive prerequisites without mutating service state", () => {
    const harness = makeHarness();
    harness.env.CACHELANE_INACTIVE_UNIT = "cachelane-claude.service";
    const result = runWorker(harness.env);
    const mutations = readLog(harness.logPath)
      .split("\n")
      .filter((line) => /^systemctl (?:start|stop) /.test(line));

    expect(result.status).not.toBe(0);
    expect(mutations).toEqual([]);
  });

  it("maintains one lane at a time and runs the final healthcheck", () => {
    const harness = makeHarness();
    const result = runWorker(harness.env);
    const log = readLog(harness.logPath);
    const lines = log.split("\n");
    const stopLines = lines.filter((line) => line.startsWith("systemctl stop"));

    expect(result.status).toBe(0);
    for (const [index, databasePath] of harness.databasePaths.entries()) {
      const database = new Database(databasePath, { readonly: true });
      expect(database.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(database.pragma("freelist_count", { simple: true }) as number).toBe(0);
      database.close();
      const initialSize = harness.initialSizes[index];
      if (initialSize === undefined) throw new Error("missing initial database size");
      expect(fs.statSync(databasePath).size).toBeLessThan(initialSize);
    }
    expect(stopLines).toContain("systemctl stop cachelane-healthcheck.timer");
    expect(stopLines).toContain("systemctl stop cachelane-healthcheck.service");
    expect(stopLines).toContain("systemctl stop cachelane-claude.service");
    expect(stopLines).toContain("systemctl stop cachelane-litellm.service");
    expect(lines.indexOf("systemctl stop cachelane-healthcheck.service")).toBeLessThan(
      lines.indexOf("systemctl stop cachelane-claude.service"),
    );
    expect(
      stopLines.every(
        (line) =>
          !(line.includes("cachelane-claude") && line.includes("cachelane-litellm")),
      ),
    ).toBe(true);
    const claudeStart = lines.indexOf("systemctl start cachelane-claude.service");
    const litellmStop = lines.indexOf("systemctl stop cachelane-litellm.service");
    const litellmStart = lines.indexOf("systemctl start cachelane-litellm.service");
    expect(claudeStart).toBeGreaterThan(-1);
    expect(litellmStop).toBeGreaterThan(-1);
    expect(litellmStart).toBeGreaterThan(-1);
    expect(claudeStart).toBeLessThan(litellmStop);
    expect(litellmStart).toBeGreaterThan(litellmStop);
    expect(log).toContain("systemctl start cachelane-healthcheck.service");
  });

  it("rejects a non-200 health response even when its body says ok", () => {
    const harness = makeHarness();
    harness.env.CACHELANE_HEALTH_STATUS = "302";
    const result = runWorker(harness.env);
    const log = readLog(harness.logPath);

    expect(result.status).not.toBe(0);
    expect(log).toContain("systemctl start cachelane-claude.service");
    expect(log).toContain("systemctl start cachelane-litellm.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.timer");
  });

  it("returns non-zero and recovers every unit when a health gate fails", () => {
    const harness = makeHarness();
    harness.env.CACHELANE_HEALTH_FAIL = "1";
    const result = runWorker(harness.env);
    const log = readLog(harness.logPath);

    expect(result.status).not.toBe(0);
    expect(log).toContain("systemctl start cachelane-claude.service");
    expect(log).toContain("systemctl start cachelane-litellm.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.service");
    expect(log).toContain("systemctl start cachelane-healthcheck.timer");
  });

  it("executes the default launcher branch with the fixed detached command", () => {
    const harness = makeHarness();
    const capturePath = `${harness.logPath}.launch`;
    harness.env.CACHELANE_LAUNCH_CAPTURE = capturePath;
    const result = spawnSync("bash", [maintenanceScriptPath], {
      env: harness.env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(capturePath, "utf8").trim().split("\n")).toEqual([
      "/usr/bin/sudo",
      "/usr/bin/systemd-run",
      "--unit=cachelane-db-maintenance",
      "--collect",
      "--wait",
      "--property=Type=oneshot",
      "/usr/local/sbin/cachelane-compact-runtime-databases",
      "--worker",
    ]);
  });

  it("validates every privileged worker path ancestor", () => {
    expect(maintenanceScript).toContain(
      'for path in / /usr /usr/local /usr/local/sbin "$PRIVILEGED_WORKER"; do',
    );
  });

  it("prints a fixed privileged launch command with no caller-controlled paths", () => {
    const harness = makeHarness();
    const result = spawnSync("bash", [maintenanceScriptPath, "--dry-run"], {
      env: harness.env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "/usr/bin/sudo /usr/bin/systemd-run --unit=cachelane-db-maintenance --collect --wait --property=Type=oneshot /usr/local/sbin/cachelane-compact-runtime-databases --worker",
    );
    expect(result.stdout).not.toContain(harness.env.CACHELANE_INSTALL!);
    expect(result.stdout).not.toContain("--setenv=");
  });
});
