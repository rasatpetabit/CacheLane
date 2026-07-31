#!/usr/bin/env node
/**
 * Show CacheLane stats for both production homes:
 *   LiteLLM  → ~/.cachelane-litellm (:7332)
 *   Claude Code → ~/.cachelane-claude (:7333 → Anthropic)
 *
 * Post-processes CLI text so large counts/costs are compact
 * (e.g. 33552092 → 33.55M) while leaving % and IDs alone.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const cli = process.env.CACHELANE_CLI ?? "/srv/cachelane/dist/cli/index.cjs";
const homes = [
  { name: "LiteLLM (:7332)", home: join(homedir(), ".cachelane-litellm") },
  { name: "Claude → Anthropic (:7333)", home: join(homedir(), ".cachelane-claude") },
];

function run(home, args) {
  const r = spawnSync("node", [cli, ...args], {
    env: { ...process.env, CACHELANE_HOME: home },
    encoding: "utf8",
  });
  return (r.stdout || "") + (r.stderr || "");
}

/** Compact form: 33552092 → 33.55M, 136944 → 136.9K, 997 → 997 */
function formatCompact(n) {
  const abs = Math.abs(n);
  if (!Number.isFinite(n) || abs < 1000) {
    return Number.isInteger(n) ? String(n) : String(n);
  }

  const units = [
    { v: 1e12, s: "T" },
    { v: 1e9, s: "B" },
    { v: 1e6, s: "M" },
    { v: 1e3, s: "K" },
  ];
  for (const u of units) {
    if (abs >= u.v) {
      const val = n / u.v;
      // Prefer 2 decimals under 100 so 33552092 → 33.55M (not 33.6M)
      const digits = Math.abs(val) < 100 ? 2 : 0;
      let s = val.toFixed(digits);
      // strip trailing zeros after decimal: 5.50 → 5.5, 100.0 → 100
      if (s.includes(".")) s = s.replace(/\.?0+$/, "");
      return `${s}${u.s}`;
    }
  }
  return String(n);
}

/**
 * Rewrite large plain numbers in stats/sessions text.
 * Skips: percentages (…%), session UUIDs, dates, already-suffixed values.
 */
function humanizeText(text) {
  return text
    .split("\n")
    .map((line) => {
      // Leave header / separator / help lines alone if they have no metric numbers
      return line.replace(
        // number not part of uuid/date/path; not followed by % or unit letter already
        /(?<![\w./-])(\d{1,3}(?:,\d{3})+|\d{4,}(?:\.\d+)?|\d+\.\d{2,})(?![\w.%/-])/g,
        (raw) => {
          const n = Number(String(raw).replace(/,/g, ""));
          if (!Number.isFinite(n) || Math.abs(n) < 1000) return raw;
          return formatCompact(n);
        },
      );
    })
    .join("\n");
}

for (const h of homes) {
  console.log(`\n======== ${h.name}  CACHELANE_HOME=${h.home} ========`);
  console.log(humanizeText(run(h.home, ["stats", "--scope", "all"]).trim()));
  console.log("--- sessions (top) ---");
  const sessions = run(h.home, ["sessions"]).trim().split("\n").slice(0, 12).join("\n");
  console.log(humanizeText(sessions));
}
console.log(`\nHTML report (Pi):  CACHELANE_HOME=~/.cachelane-litellm node ${cli} report --scope all --no-open`);
console.log(`HTML report (CC):  CACHELANE_HOME=~/.cachelane-claude node ${cli} report --scope all --no-open`);
console.log(`MCP tools in Claude Code: cachelane_stats, cachelane_explain, cachelane_health, cachelane_expand`);
console.log(`  (server "cachelane" → CC home; server "cachelane-pi" → LiteLLM home)`);
