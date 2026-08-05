# CacheLane hook stats historical repair runbook

> **Status:** documented procedure only.  
> **This remediation task did not execute the repair.**  
> Do not treat the presence of this runbook as evidence that historical rows were corrected.

This runbook describes a future, human-authorized, exact-match repair of historical Claude hook telemetry rows that were persisted with incorrect cache-creation tiering, provenance signals, mutation flags, and timestamps. It is intentionally **not** an executable backfill. Operators must perform each stage deliberately; no automated migration ships with this documentation.

## When to use

Use only when all of the following are true:

1. Future hook ingestion has already been fixed and deployed (installed runtime `GIT_SHA` matches the remediated repository HEAD).
2. Historical Claude-lane rows still show pre-remediation symptoms (for example missing `usage:recorded`, false `request_mutated=1`, mis-bucketed `cache_creation_*` tiers, or hook-time timestamps instead of transcript event times).
3. Local Claude Code transcripts that produced those rows are still available and readable.
4. A human operator has scheduled a maintenance window and will authorize write mode after reviewing the preview.

Do **not** use this runbook to invent synthetic usage, rewrite unmatched rows, or "best-effort" fuzzy-match transcripts.

## Safety contract

- **Exact match only.** Candidate rows join to transcript assistant usage by `(session_id, message.id)`. No partial, fuzzy, or heuristic joins.
- **Preview before write.** Write mode is forbidden until a read-only preview reports matched / unmatched / already-correct / ambiguous counts and a human authorizes the write.
- **Backup before mutation.** Checkpoint WAL and copy DB + WAL + SHM to a timestamped backup directory before any write transaction.
- **Transaction + invariants.** Updates run inside a single transaction. Any invariant mismatch forces **rollback**.
- **No live DB touch from this task.** Creating or reading this document must not modify `~/.cachelane-claude/cachelane.db` or any other lane database.
- **No claim of historical repair** until post-start verification on the repaired DB succeeds and is recorded by the operator.

## Defects this repair targets

Pre-remediation hook ingestion could:

| Field / signal | Incorrect historical behavior | Correct target |
|---|---|---|
| `cache_creation_5m_tokens` / `cache_creation_1h_tokens` | Nested one-hour writes mis-assigned to the five-minute bucket (or total creation collapsed into 5m) | Nested `usage.cache_creation.ephemeral_*` first; exclusive 5m/1h buckets |
| `cache_write_tokens` | Derived from wrong tier split | `cache_creation_5m_tokens + cache_creation_1h_tokens` |
| `effective_cost_units` | Weighted with wrong tier multipliers | `input + 1.25*5m + 2.0*1h + 0.1*read` (same formula as current CLI) |
| `signals` | Missing `usage:recorded` (often only `mode:hook`) | `["mode:hook","usage:recorded"]` JSON array |
| `request_mutated` | Stored as `1` even though hook-mutate is a no-op | `0` |
| `created_at` | Hook execution wall clock | Parsed transcript event timestamp (ISO or numeric); one deterministic fallback only when the transcript timestamp is invalid |

Rows without an exact transcript match remain **untouched**.

## Phase 0 — Prerequisites (read-only)

1. Confirm the installed runtime already contains the future-path fixes:

   ```bash
   cat /srv/cachelane/GIT_SHA
   git -C /path/to/cachelane-repo rev-parse HEAD
   # These two SHAs must match before repairing history.
   ```

2. Identify lane homes and the Claude DB path:

   | Lane | Typical home | Database |
   |---|---|---|
   | Claude (primary target) | `~/.cachelane-claude` (or `CACHELANE_HOME` override) | `$HOME/.cachelane-claude/cachelane.db` |
   | Default symlink | `~/.cachelane` → often `.cachelane-claude` | resolve with `readlink -f` |
   | LiteLLM | `~/.cachelane-litellm` | **out of scope** for Claude hook transcript repair |

   ```bash
   echo "CLAUDE_HOME=${CACHELANE_HOME:-$HOME/.cachelane-claude}"
   CLAUDE_HOME="${CACHELANE_HOME:-$HOME/.cachelane-claude}"
   CLAUDE_DB="$CLAUDE_HOME/cachelane.db"
   ls -la "$CLAUDE_DB" "$CLAUDE_DB-wal" "$CLAUDE_DB-shm" 2>/dev/null || true
   ```

3. Identify affected Claude transcript roots (Claude Code session JSONL). Common locations:

   ```bash
   # Adjust for the operator account that produced the sessions.
   ls -la ~/.claude/projects 2>/dev/null || true
   ls -la ~/.config/claude/projects 2>/dev/null || true
   # Transcript files are typically:
   #   <projects-root>/<encoded-workspace>/<session_id>.jsonl
   ```

4. Inventory candidate historical hook rows **without writing**:

   ```bash
   sqlite3 "$CLAUDE_DB" "
     SELECT COUNT(*) AS candidate_hook_rows
     FROM turns
     WHERE provider = 'anthropic'
       AND (
         signals LIKE '%mode:hook%'
         OR signals LIKE '%\"mode:hook\"%'
       );
   "
   ```

Stop here if you only needed an inventory. The remainder of this document is a future operator procedure.

## Phase 1 — Stop writers

Stop every process that can open the Claude DB for write:

```bash
systemctl stop cachelane-claude.service
# Also stop any ad-hoc proxy/hook writers for the Claude home, e.g.:
#   pkill -f 'cachelane.*proxy'   # only if operator-confirmed Claude writers remain
systemctl is-active cachelane-claude.service || echo "claude service stopped"
```

Confirm no residual writers hold the DB (no active Claude Code sessions writing hooks into this home, no leftover `node dist/cli` proxy for the Claude home).

Do **not** stop LiteLLM lane services unless the operator intentionally includes that home in the same maintenance window (not required for Claude-only repair).

## Phase 2 — Checkpoint WAL and backup

Create a timestamped backup directory and copy the full SQLite file set **after** checkpointing WAL into the main DB file when possible:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${CLAUDE_HOME}/backups/hook-stats-repair-${STAMP}"
mkdir -p "$BACKUP_DIR"

# Prefer an exclusive checkpoint while writers are stopped.
sqlite3 "$CLAUDE_DB" "PRAGMA wal_checkpoint(TRUNCATE);"

cp -a "$CLAUDE_DB" "$BACKUP_DIR/cachelane.db"
# Copy sidecars if they still exist after checkpoint.
[[ -f "${CLAUDE_DB}-wal" ]] && cp -a "${CLAUDE_DB}-wal" "$BACKUP_DIR/cachelane.db-wal"
[[ -f "${CLAUDE_DB}-shm" ]] && cp -a "${CLAUDE_DB}-shm" "$BACKUP_DIR/cachelane.db-shm"

# Provenance for the backup set
{
  echo "stamp=${STAMP}"
  echo "source_db=${CLAUDE_DB}"
  echo "repo_git_sha=$(git -C /path/to/cachelane-repo rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "installed_git_sha=$(cat /srv/cachelane/GIT_SHA 2>/dev/null || echo unknown)"
  sha256sum "$BACKUP_DIR"/cachelane.db*
} | tee "$BACKUP_DIR/MANIFEST.txt"

ls -la "$BACKUP_DIR"
```

Do not proceed without a readable backup and manifest.

## Phase 3 — Read-only preview (mandatory)

Build a **preview-only** mapping from historical hook turns to transcript assistant messages by **exact match** on:

```text
(session_id, message.id)  ==  (transcript session file stem / hook session_id, assistant message id)
```

For each candidate DB row (`turns.id` is the Anthropic/Claude message id used at insert time):

1. Locate the transcript JSONL for `session_id`.
2. Parse assistant entries with `message.usage` using the same rules as the remediated parser:
   - prefer nested `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`;
   - fall back to legacy top-level tier fields only when nested detail is absent;
   - never assign total `cache_creation_input_tokens` to the 5m bucket when explicit 1h detail exists;
   - parse string ISO timestamps with `Date.parse`; accept only finite results;
   - use one deterministic fallback timestamp for invalid/missing event times (do not call wall-clock per row during preview aggregation).
3. Classify each candidate into exactly one bucket:

| Preview bucket | Meaning |
|---|---|
| **matched** | Exactly one transcript usage entry for `(session_id, message.id)` and at least one correctable field differs |
| **already-correct** | Exact match exists and all target fields already equal the repaired values |
| **unmatched** | No transcript usage entry for that pair |
| **ambiguous** | More than one conflicting transcript usage entry for the same pair, or unreadable/partial transcript evidence |

Report at least:

```text
matched=<n>
unmatched=<n>
already_correct=<n>
ambiguous=<n>
```

plus a sample of each non-zero class (session id, message id, current vs proposed tiers/signals/flags/timestamps).

**Hard rules for preview:**

- Preview mode must open the DB read-only (`sqlite3 "file:$CLAUDE_DB?mode=ro"` or equivalent) and must not `UPDATE`/`INSERT`/`DELETE`.
- Ambiguous and unmatched rows are **never** write candidates.
- Already-correct rows are listed but not rewritten.

## Phase 4 — Explicit human authorization

Write mode requires **explicit human authorization** after the preview is reviewed. Authorization must record:

- operator identity;
- preview counts (matched / unmatched / already-correct / ambiguous);
- backup directory path;
- target DB path;
- installed and repo `GIT_SHA` values;
- maintenance window notes.

Suggested authorization gate (example — adapt to local change control):

```text
I authorize write-mode exact-match repair of <matched> rows in
<CLAUDE_DB> using backup <BACKUP_DIR>. Unmatched/ambiguous rows stay
untouched. Operator: <name>. Time (UTC): <stamp>.
```

Without that authorization, stop after Phase 3.

## Phase 5 — Transactional exact-match update

Only after authorization, open a single write transaction and update **matched** rows only.

Fields to correct on each exact match:

```sql
-- Pseudocode for the per-row UPDATE body (exact match only)
UPDATE turns
SET
  cache_creation_5m_tokens = :parsed_5m,
  cache_creation_1h_tokens = :parsed_1h,
  cache_write_tokens       = :parsed_5m + :parsed_1h,
  cache_read_tokens        = :parsed_read,          -- only if transcript is authoritative and currently wrong
  input_tokens             = :parsed_input,         -- only if currently wrong vs transcript
  output_tokens            = :parsed_output,        -- only if currently wrong vs transcript
  effective_cost_units     = :recomputed_effective, -- from corrected token columns
  signals                  = '["mode:hook","usage:recorded"]',
  request_mutated          = 0,
  created_at               = :parsed_created_at
WHERE id = :message_id
  AND session_id = :session_id
  -- optional defensive predicates:
  AND provider = 'anthropic';
```

Implementation constraints:

- Update only rows present in the authorized matched set.
- Do **not** allocate new turn numbers, insert new rows, or delete rows.
- Do **not** modify LiteLLM-home databases in the same transaction.
- Keep the transaction open until Phase 6 invariants pass; **rollback** on any failure.

Effective cost recompute (must match product formula):

```text
effective_cost_units =
    input_tokens
  + 1.25 * cache_creation_5m_tokens
  + 2.0  * cache_creation_1h_tokens
  + 0.1  * cache_read_tokens
```

## Phase 6 — Invariant assertions (pre-commit)

Before `COMMIT`, assert all of the following. On any mismatch: `ROLLBACK` immediately and leave the live DB unchanged (then restore from backup if the file was left inconsistent outside the transaction).

1. **Row identity stability**
   - total `turns` row count unchanged;
   - set of `turns.id` unchanged;
   - set of `(session_id, turn_number)` pairs unchanged;
   - no new sessions introduced.

2. **Exclusive cache-creation buckets**
   - for every updated row: `cache_write_tokens = cache_creation_5m_tokens + cache_creation_1h_tokens`;
   - no negative tier columns;
   - when transcript nested 1h detail was present, 5m/1h split matches that detail (not total-only collapse into 5m).

3. **Corrected tier totals**
   - sum of `cache_creation_5m_tokens` / `cache_creation_1h_tokens` / `cache_read_tokens` over the matched set equals the transcript-derived totals for that set.

4. **Recorded usage provenance**
   - every updated row's `signals` JSON includes both `mode:hook` and `usage:recorded`.

5. **No-op pipeline outcome**
   - every updated row has `request_mutated = 0` (hook path does not mutate the request).

6. **Timestamp ranges**
   - every updated `created_at` is a finite epoch-ms value;
   - when the transcript timestamp was valid, `created_at` equals that parsed value exactly;
   - no updated timestamp is later than the maintenance window start solely because of wall-clock rewrite during repair (fallback timestamps, if any, must be the single deterministic fallback chosen for that repair run and recorded in the operator log).

7. **Non-candidates untouched**
   - checksum or full-row compare for a sample (preferably all) of unmatched, ambiguous, and already-correct rows is identical to the pre-write snapshot.

Only if every assertion passes: `COMMIT`.

## Phase 7 — Rollback on mismatch

If any Phase 6 assertion fails:

```sql
ROLLBACK;
```

Then, if the DB file could have been modified outside a clean rollback path, restore the backup:

```bash
systemctl is-active cachelane-claude.service && systemctl stop cachelane-claude.service
cp -a "$BACKUP_DIR/cachelane.db" "$CLAUDE_DB"
# Restore sidecars only if the backup retained them; otherwise remove stale sidecars
# so SQLite does not mix a restored main DB with newer WAL/SHM.
rm -f "${CLAUDE_DB}-wal" "${CLAUDE_DB}-shm"
[[ -f "$BACKUP_DIR/cachelane.db-wal" ]] && cp -a "$BACKUP_DIR/cachelane.db-wal" "${CLAUDE_DB}-wal"
[[ -f "$BACKUP_DIR/cachelane.db-shm" ]] && cp -a "$BACKUP_DIR/cachelane.db-shm" "${CLAUDE_DB}-shm"
sqlite3 "$CLAUDE_DB" "PRAGMA integrity_check;"
```

Record the failed invariant, preview counts, and backup path. Do not retry write mode until the root cause is understood.

## Phase 8 — Restart and live verification

```bash
systemctl start cachelane-claude.service
systemctl is-active --quiet cachelane-claude.service

# Installed artifact identity
cat /srv/cachelane/GIT_SHA

# CLI label smoke (temporary home — does not prove historical repair by itself)
CACHELANE_HOME="$(mktemp -d)" /srv/cachelane/dist/cli/index.cjs stats --scope all 2>/dev/null | head
```

Historical-repair-specific checks against the repaired Claude home:

```bash
export CACHELANE_HOME="$CLAUDE_HOME"
# Prefer the installed CLI after deployment of the remediated GIT_SHA.
cachelane stats --scope all
cachelane sessions
```

Verify operator-facing text uses non-causal wording (observed provider cache reuse / estimated provider input-cost savings) and that sampled repaired sessions no longer show the pre-remediation hook defects for matched message ids.

## Phase 9 — Restore if post-start verification fails

If post-start verification fails (integrity check, impossible aggregates, service crash loop, or repaired samples still wrong after a confirmed exact-match commit):

1. Stop `cachelane-claude.service` again.
2. Restore from `$BACKUP_DIR` exactly as in Phase 7.
3. Restart and re-verify against the restored backup.
4. Leave historical rows unrepaired until a corrected procedure is reviewed.

## Operator log template

```text
date_utc:
operator:
repo_git_sha:
installed_git_sha:
claude_home:
claude_db:
backup_dir:
preview_matched:
preview_unmatched:
preview_already_correct:
preview_ambiguous:
authorization_recorded: yes/no
write_mode_executed: yes/no
transaction_result: commit/rollback/not-run
post_start_verification: pass/fail/not-run
notes:
```

## Explicit non-claims

- **This documentation task did not execute the repair.**
- No executable backfill script is provided or required by this runbook.
- Linking this file from the README does **not** mean historical data has been repaired.
- Future hook ingestion fixes alone do not rewrite old rows; only an authorized run of this procedure (or an equivalent reviewed tool that enforces the same safeguards) can.

## Related references

- Design: `docs/superpowers/specs/2026-08-05-stats-telemetry-remediation-design.md`
- Plan Task 4: `docs/superpowers/plans/2026-08-05-stats-telemetry-remediation.md`
- Claude effectiveness measurement: [`docs/runbook-claude-effectiveness.md`](../runbook-claude-effectiveness.md)
- Installed runtime identity: `/srv/cachelane/GIT_SHA`
