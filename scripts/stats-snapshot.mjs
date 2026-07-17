#!/usr/bin/env node
/** Append dual-home stats JSON lines for trend watching. */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cli = process.env.CACHELANE_CLI ?? "/srv/cachelane/dist/cli/index.cjs";
const outDir = process.env.CACHELANE_STATS_DIR ?? join(homedir(), ".cachelane-ops");
const outFile = join(outDir, "stats-snapshots.jsonl");
mkdirSync(outDir, { recursive: true });

function stats(home) {
  if (!existsSync(home)) return { missing: true, home };
  const r = spawnSync("node", [cli, "stats", "--scope", "all", "--json"], {
    env: { ...process.env, CACHELANE_HOME: home },
    encoding: "utf8",
  });
  try {
    return JSON.parse((r.stdout || "").trim() || "{}");
  } catch {
    return { parse_error: true, stdout: (r.stdout || "").slice(0, 200), home };
  }
}

const row = {
  ts: new Date().toISOString(),
  pi: stats(join(homedir(), ".cachelane-openai")),
  cc: stats(join(homedir(), ".cachelane-claude")),
};
appendFileSync(outFile, JSON.stringify(row) + "\n");
console.log(JSON.stringify({ wrote: outFile, pi_turns: row.pi.turns, cc_turns: row.cc.turns, pi_savings: row.pi.savings_ratio, cc_savings: row.cc.savings_ratio }));
