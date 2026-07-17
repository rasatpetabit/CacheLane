#!/usr/bin/env node
/**
 * CacheLane soak snapshot — append one JSON line of aggregate metrics.
 *
 * Usage:
 *   CACHELANE_HOME=~/.cachelane-openai node scripts/soak-snapshot.mjs
 *   CACHELANE_HOME=~/.cachelane-openai node scripts/soak-snapshot.mjs --label day0-baseline
 *
 * Writes: $CACHELANE_HOME/soak/snapshots.jsonl
 * Prints: the same object to stdout (pretty).
 */
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const home = process.env.CACHELANE_HOME || join(homedir(), ".cachelane-claude");
const labelArg = process.argv.indexOf("--label");
const label = labelArg >= 0 ? process.argv[labelArg + 1] : null;
const dbPath = join(home, "cachelane.db");
const cfgPath = join(home, "config.json");
const outDir = join(home, "soak");
const outPath = join(outDir, "snapshots.jsonl");

if (!existsSync(dbPath)) {
  console.error(`no db at ${dbPath}`);
  process.exit(1);
}

const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : null;
const db = new DatabaseSync(dbPath, { readOnly: true });

function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

const totals = one(`
  SELECT
    COUNT(*) AS turns,
    COALESCE(SUM(request_mutated),0) AS mutated_turns,
    COALESCE(SUM(CASE WHEN pruned_blocks_count > 0 THEN 1 ELSE 0 END),0) AS prune_fire_turns,
    COALESCE(SUM(pruned_blocks_count),0) AS pruned_blocks,
    COALESCE(SUM(input_tokens),0) AS input_tokens_sum,
    COALESCE(SUM(output_tokens),0) AS output_tokens_sum,
    COALESCE(SUM(CASE WHEN signals LIKE '%mode:baseline%' THEN 1 ELSE 0 END),0) AS baseline_turns,
    COALESCE(SUM(CASE WHEN signals LIKE '%pruned:%' THEN 1 ELSE 0 END),0) AS pruned_signal_turns
  FROM turns
`);

const byModel = all(`
  SELECT model,
    COUNT(*) AS turns,
    COALESCE(SUM(CASE WHEN pruned_blocks_count > 0 THEN 1 ELSE 0 END),0) AS prune_fire_turns,
    COALESCE(SUM(pruned_blocks_count),0) AS pruned_blocks,
    COALESCE(SUM(input_tokens),0) AS input_tokens
  FROM turns
  GROUP BY model
  ORDER BY turns DESC
`);

// reclaim from explanations when available
let reclaimed = { tokens_reclaimed_sum: 0, decisions: 0 };
try {
  const r = one(`
    SELECT
      COALESCE(SUM(
        CASE WHEN json_valid(prune_decisions_json)
        THEN (
          SELECT COALESCE(SUM(json_extract(value, '$.tokens_reclaimed')),0)
          FROM json_each(prune_decisions_json)
        ) ELSE 0 END
      ),0) AS tokens_reclaimed_sum,
      COALESCE(SUM(
        CASE WHEN json_valid(prune_decisions_json)
        THEN json_array_length(prune_decisions_json) ELSE 0 END
      ),0) AS decisions
    FROM turn_explanations
  `);
  if (r) reclaimed = r;
} catch {
  /* older schema */
}

const sessions = one(`SELECT COUNT(DISTINCT session_id) AS sessions FROM turns`);
const recent = one(`
  SELECT MIN(created_at) AS first_turn, MAX(created_at) AS last_turn FROM turns
`);

const snap = {
  ts: new Date().toISOString(),
  label,
  home,
  features: cfg?.features ?? null,
  upstream: cfg?.proxy
    ? {
        host: cfg.proxy.upstream_host,
        port: cfg.proxy.upstream_port,
        ssl: cfg.proxy.upstream_ssl,
      }
    : null,
  totals: { ...totals, sessions: sessions?.sessions ?? 0, ...recent },
  reclaimed,
  by_model: byModel,
};

mkdirSync(outDir, { recursive: true });
appendFileSync(outPath, JSON.stringify(snap) + "\n");
db.close();
console.log(JSON.stringify(snap, null, 2));
console.error(`appended → ${outPath}`);
