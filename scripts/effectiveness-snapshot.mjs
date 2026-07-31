#!/usr/bin/env node
/**
 * Append a forward-compatible effectiveness snapshot for both production homes.
 * Read-only: invokes the installed CLI and records its stable JSON output.
 *
 * Usage:
 *   node scripts/effectiveness-snapshot.mjs --label pre-fix
 *   CACHELANE_CLI=dist/cli/index.js node scripts/effectiveness-snapshot.mjs
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};
const label = arg("--label");
const cli = process.env.CACHELANE_CLI ?? "/srv/cachelane/dist/cli/index.cjs";
const out = process.env.CACHELANE_EFFECTIVENESS_LOG ?? join(homedir(), ".cachelane-ops", "effectiveness.jsonl");
const homes = [
  ["litellm", join(homedir(), ".cachelane-litellm")],
  ["claude", join(homedir(), ".cachelane-claude")],
];

function runStats(home) {
  const r = spawnSync("node", [cli, "stats", "--scope", "all", "--json"], {
    env: { ...process.env, CACHELANE_HOME: home },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `stats exited ${r.status}`).trim());
  const first = r.stdout.indexOf("{");
  if (first < 0) throw new Error("stats JSON not found");
  return JSON.parse(r.stdout.slice(first));
}

function installedSha() {
  const defaultCli = "/srv/cachelane/dist/cli/index.cjs";
  if (cli !== defaultCli) return null;
  try { return readFileSync("/srv/cachelane/GIT_SHA", "utf8").trim(); }
  catch { return null; }
}

const snapshot = {
  ts: new Date().toISOString(),
  label,
  installed_sha: installedSha(),
  cli_path: cli,
  stats_schema: 1,
  lanes: Object.fromEntries(homes.map(([name, home]) => [name, { home, stats: runStats(home) }])),
};

mkdirSync(dirname(out), { recursive: true });
appendFileSync(out, `${JSON.stringify(snapshot)}\n`);
console.log(JSON.stringify(snapshot, null, 2));
console.error(`appended → ${out}`);
