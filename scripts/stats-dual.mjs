#!/usr/bin/env node
/**
 * Show CacheLane stats for both production homes:
 *   Pi/LiteLLM  → ~/.cachelane-smoke (:7332)
 *   Claude Code → ~/.cachelane       (:7333 → Anthropic)
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const cli = process.env.CACHELANE_CLI ?? "/srv/cachelane/dist/cli/index.cjs";
const homes = [
  { name: "Pi / LiteLLM (:7332)", home: join(homedir(), ".cachelane-smoke") },
  { name: "Claude Code / Anthropic (:7333)", home: join(homedir(), ".cachelane") },
];

function run(home, args) {
  const r = spawnSync("node", [cli, ...args], {
    env: { ...process.env, CACHELANE_HOME: home },
    encoding: "utf8",
  });
  return (r.stdout || "") + (r.stderr || "");
}

for (const h of homes) {
  console.log(`\n======== ${h.name}  CACHELANE_HOME=${h.home} ========`);
  console.log(run(h.home, ["stats", "--scope", "all"]).trim());
  console.log("--- sessions (top) ---");
  const sessions = run(h.home, ["sessions"]).trim().split("\n").slice(0, 12).join("\n");
  console.log(sessions);
}
console.log(`\nHTML report (Pi):  CACHELANE_HOME=~/.cachelane-smoke node ${cli} report --scope all --no-open`);
console.log(`HTML report (CC):  CACHELANE_HOME=~/.cachelane node ${cli} report --scope all --no-open`);
console.log(`MCP tools in Claude Code: cachelane_stats, cachelane_explain, cachelane_health, cachelane_expand`);
console.log(`  (server "cachelane" → CC home; server "cachelane-pi" → Pi/LiteLLM home)`);
