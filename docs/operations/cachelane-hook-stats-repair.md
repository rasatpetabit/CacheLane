<!-- docs-rebuild: exempt SHARD_CEILING — sequential exact-match repair procedure; split would break the ordered safety contract -->
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

1. Confirm the installed runtime already contains the telemetry remediation fixes (transcript tier parsing, honest hook outcomes, non-attribution labels):

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
   # Inventory/detail opens later must assert existence + use mode=ro URI.
   [[ -f "$CLAUDE_DB" ]] || { echo "ERROR: missing DB: $CLAUDE_DB" >&2; exit 1; }
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

4. Inventory candidate historical hook rows **without writing**. Use `json_each` exact equality for `mode:hook`; do **not** use `LIKE '%mode:hook%'` (it can false-match nested text). Quarantine malformed or non-array `signals` into a separate report — those rows are **not** write candidates until a human decides how to handle them.

   **SQL safety for `signals`:**
   - Never call bare `json_type(signals)` on untrusted text. SQLite may evaluate `json_type(...)` even when a sibling `json_valid(...)` predicate is present in `AND`/`OR` chains and raise `malformed JSON`. Guard every `json_type` with `CASE WHEN signals IS NOT NULL AND json_valid(signals) THEN json_type(signals) END` (or equivalent CTE normalization).
   - Never pass raw untrusted `signals` into `json_each`, even behind a sibling `signals_json_type = 'array'` predicate. Normalize a sanitized expression first:
     `safe_signals = CASE WHEN <type-is-array> THEN signals ELSE '[]' END`, then call **`json_each(safe_signals)` only**.
   - A `WITH typed AS (...)` CTE scopes **only the immediately following single statement**. Multi-statement scripts must either (a) combine counts into **one** `SELECT`, or (b) **repeat** the full typed/`safe_signals` CTE before every later statement/detail query. Do not reference `typed` from a second statement after a first statement already consumed the CTE.

   Combined inventory (candidate + quarantine counts in **one** statement — preferred).
   **Open contract (required for every inventory/detail query against a real DB):**
   1. Assert the DB file exists first (`test -f` / `[[ -f ... ]]`); abort if missing.
   2. Open with the SQLite **read-only URI** (`file:$CLAUDE_DB?mode=ro`) — never a bare writeable path for inventory/detail.
   3. Do not `UPDATE`/`INSERT`/`DELETE` in inventory/detail sessions.

   ```bash
   # Fail closed if the DB path is missing (do not open a new empty DB by accident).
   [[ -f "$CLAUDE_DB" ]] || { echo "ERROR: missing DB: $CLAUDE_DB" >&2; exit 1; }
   sqlite3 "file:${CLAUDE_DB}?mode=ro" "
     -- Normalize type + safe_signals once per statement.
     -- bare json_type(signals) and json_each(raw signals) are forbidden on untrusted text.
     WITH base AS (
       SELECT
         t.id,
         t.session_id,
         t.provider,
         t.signals,
         CASE
           WHEN t.signals IS NOT NULL AND json_valid(t.signals)
           THEN json_type(t.signals)
         END AS signals_json_type
       FROM turns t
     ),
     typed AS (
       SELECT
         b.*,
         CASE
           WHEN b.signals_json_type = 'array' THEN b.signals
           ELSE '[]'
         END AS safe_signals
       FROM base b
     )
     SELECT
       (SELECT COUNT(*)
        FROM typed t
        WHERE t.provider = 'anthropic'
          AND t.signals_json_type = 'array'
          AND EXISTS (
            SELECT 1
            FROM json_each(t.safe_signals) je
            WHERE je.value = 'mode:hook'
          )
       ) AS candidate_hook_rows,
       (SELECT COUNT(*)
        FROM typed t
        WHERE t.provider = 'anthropic'
          AND (
            t.signals IS NULL
            OR t.signals_json_type IS NULL
            OR t.signals_json_type != 'array'
          )
       ) AS quarantine_malformed_or_non_array_signals;
   "
   ```

   Optional quarantine detail (read-only). **Repeat** the full CTE — a prior statement's `typed` is out of scope.
   Same open contract: existing-file assertion + read-only URI.

   ```bash
   [[ -f "$CLAUDE_DB" ]] || { echo "ERROR: missing DB: $CLAUDE_DB" >&2; exit 1; }
   sqlite3 "file:${CLAUDE_DB}?mode=ro" "
     WITH base AS (
       SELECT
         t.id,
         t.session_id,
         t.provider,
         t.signals,
         CASE
           WHEN t.signals IS NOT NULL AND json_valid(t.signals)
           THEN json_type(t.signals)
         END AS signals_json_type
       FROM turns t
     ),
     typed AS (
       SELECT
         b.*,
         CASE
           WHEN b.signals_json_type = 'array' THEN b.signals
           ELSE '[]'
         END AS safe_signals
       FROM base b
     )
     SELECT t.id, t.session_id, t.signals, t.signals_json_type
     FROM typed t
     WHERE t.provider = 'anthropic'
       AND (
         t.signals IS NULL
         OR t.signals_json_type IS NULL
         OR t.signals_json_type != 'array'
       )
     LIMIT 50;
   "
   ```

   Equivalent inline guards (when a CTE is inconvenient):

   ```sql
   -- type proof
   CASE WHEN t.signals IS NOT NULL AND json_valid(t.signals)
        THEN json_type(t.signals)
   END = 'array'

   -- sanitized feed for json_each (never pass raw t.signals)
   json_each(
     CASE
       WHEN (
         CASE WHEN t.signals IS NOT NULL AND json_valid(t.signals)
              THEN json_type(t.signals)
         END
       ) = 'array'
       THEN t.signals
       ELSE '[]'
     END
   )
   ```

   **Classification note:** only the `json_each(safe_signals)` exact-equality set may enter Phase 3 preview as hook candidates. Quarantined malformed/non-array rows must be listed separately and stay out of the matched write set unless a later, explicitly authorized procedure defines a different recovery path for them.

5. **Read-only smoke (in-memory / temp table only — not the live DB).** Before trusting the inventory SQL on a real file, execute the **entire** multi-statement Phase 0 pattern (combined counts **and** quarantine detail) against a fixture covering: valid array with `mode:hook`, malformed JSON, JSON object, NULL, and other array without `mode:hook`. This check is documentation verification only; it does **not** touch `~/.cachelane-claude/cachelane.db`.

   Prefer the `sqlite3` CLI when available. If the host lacks `sqlite3`, use the Python 3 `sqlite3` stdlib fallback below (same SQL, `:memory:` only).

   ### Smoke A — `sqlite3` CLI

   ```bash
   # Uses :memory: only — never point this at a live lane DB.
   sqlite3 :memory: <<'SQL'
   CREATE TABLE turns (
     id INTEGER,
     session_id TEXT,
     provider TEXT,
     signals TEXT
   );
   INSERT INTO turns VALUES
     (1, 's-valid',   'anthropic', '["mode:hook"]'),   -- valid array candidate
     (2, 's-bad',     'anthropic', 'not-json'),        -- malformed JSON
     (3, 's-object',  'anthropic', '{"a":1}'),         -- valid JSON, non-array
     (4, 's-null',    'anthropic', NULL),              -- null signals
     (5, 's-other',   'anthropic', '["other"]');       -- array without mode:hook

   -- Forbidden patterns (illustrative only; do not leave uncommented in operator runs):
   --   SELECT json_type(signals) FROM turns WHERE id = 2;          -- bare json_type
   --   SELECT 1 FROM json_each((SELECT signals FROM turns WHERE id = 2)); -- raw untrusted feed

   -- Statement 1: combined candidate + quarantine counts (single SELECT; CTE in scope)
   WITH base AS (
     SELECT
       t.*,
       CASE
         WHEN t.signals IS NOT NULL AND json_valid(t.signals)
         THEN json_type(t.signals)
       END AS signals_json_type
     FROM turns t
   ),
   typed AS (
     SELECT
       b.*,
       CASE
         WHEN b.signals_json_type = 'array' THEN b.signals
         ELSE '[]'
       END AS safe_signals
     FROM base b
   )
   SELECT
     (SELECT COUNT(*) FROM typed t
       WHERE t.provider = 'anthropic'
         AND t.signals_json_type = 'array'
         AND EXISTS (
           SELECT 1 FROM json_each(t.safe_signals) je WHERE je.value = 'mode:hook'
         )
     ) AS candidate_hook_rows,
     (SELECT COUNT(*) FROM typed t
       WHERE t.provider = 'anthropic'
         AND (
           t.signals IS NULL
           OR t.signals_json_type IS NULL
           OR t.signals_json_type != 'array'
         )
     ) AS quarantine_malformed_or_non_array_signals;

   -- Statement 2: quarantine detail — CTE MUST be repeated (prior typed is out of scope)
   WITH base AS (
     SELECT
       t.*,
       CASE
         WHEN t.signals IS NOT NULL AND json_valid(t.signals)
         THEN json_type(t.signals)
       END AS signals_json_type
     FROM turns t
   ),
   typed AS (
     SELECT
       b.*,
       CASE
         WHEN b.signals_json_type = 'array' THEN b.signals
         ELSE '[]'
       END AS safe_signals
     FROM base b
   )
   SELECT t.id, t.session_id, t.signals, t.signals_json_type
   FROM typed t
   WHERE t.provider = 'anthropic'
     AND (
       t.signals IS NULL
       OR t.signals_json_type IS NULL
       OR t.signals_json_type != 'array'
     )
   ORDER BY t.id;
   -- Expected:
   --   counts line: 1|3   (candidate=1, quarantine=3)
   --   detail rows: ids 2,3,4 (malformed + object + NULL); not id 5 (valid array, non-candidate)
   -- Exit status must be 0 with no "malformed JSON" / "no such table: typed" error.
   SQL
   ```

   ### Smoke B — Python 3 `sqlite3` fallback (no CLI required)

   ```bash
   python3 <<'PY'
   import sqlite3

   SQL_SETUP = """
   CREATE TABLE turns (
     id INTEGER,
     session_id TEXT,
     provider TEXT,
     signals TEXT
   );
   INSERT INTO turns VALUES
     (1, 's-valid',   'anthropic', '["mode:hook"]'),
     (2, 's-bad',     'anthropic', 'not-json'),
     (3, 's-object',  'anthropic', '{"a":1}'),
     (4, 's-null',    'anthropic', NULL),
     (5, 's-other',   'anthropic', '["other"]');
   """

   SQL_COUNTS = """
   WITH base AS (
     SELECT
       t.*,
       CASE
         WHEN t.signals IS NOT NULL AND json_valid(t.signals)
         THEN json_type(t.signals)
       END AS signals_json_type
     FROM turns t
   ),
   typed AS (
     SELECT
       b.*,
       CASE
         WHEN b.signals_json_type = 'array' THEN b.signals
         ELSE '[]'
       END AS safe_signals
     FROM base b
   )
   SELECT
     (SELECT COUNT(*) FROM typed t
       WHERE t.provider = 'anthropic'
         AND t.signals_json_type = 'array'
         AND EXISTS (
           SELECT 1 FROM json_each(t.safe_signals) je WHERE je.value = 'mode:hook'
         )
     ) AS candidate_hook_rows,
     (SELECT COUNT(*) FROM typed t
       WHERE t.provider = 'anthropic'
         AND (
           t.signals IS NULL
           OR t.signals_json_type IS NULL
           OR t.signals_json_type != 'array'
         )
     ) AS quarantine_malformed_or_non_array_signals;
   """

   SQL_DETAIL = """
   WITH base AS (
     SELECT
       t.*,
       CASE
         WHEN t.signals IS NOT NULL AND json_valid(t.signals)
         THEN json_type(t.signals)
       END AS signals_json_type
     FROM turns t
   ),
   typed AS (
     SELECT
       b.*,
       CASE
         WHEN b.signals_json_type = 'array' THEN b.signals
         ELSE '[]'
       END AS safe_signals
     FROM base b
   )
   SELECT t.id, t.session_id, t.signals, t.signals_json_type
   FROM typed t
   WHERE t.provider = 'anthropic'
     AND (
       t.signals IS NULL
       OR t.signals_json_type IS NULL
       OR t.signals_json_type != 'array'
     )
   ORDER BY t.id;
   """

   con = sqlite3.connect(":memory:")
   con.executescript(SQL_SETUP)
   candidate, quarantine = con.execute(SQL_COUNTS).fetchone()
   detail = con.execute(SQL_DETAIL).fetchall()
   print(f"{candidate}|{quarantine}")
   for row in detail:
       print(row)
   assert (candidate, quarantine) == (1, 3), (candidate, quarantine)
   assert [r[0] for r in detail] == [2, 3, 4], detail
   print("SMOKE_OK")
   PY
   ```

   Success criteria for the smoke (CLI or Python): process exit `0`, counts `candidate=1` / `quarantine=3` (printed `1|3`), detail query returns the three quarantine rows without error, and **no** `malformed JSON` or `no such table: typed` error. If the smoke fails, do not run the inventory against a real DB until the SQL guards match this pattern.

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
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${CLAUDE_HOME}/backups/hook-stats-repair-${STAMP}"
mkdir -p "$BACKUP_DIR"

[[ -f "$CLAUDE_DB" ]] || { echo "ERROR: missing DB: $CLAUDE_DB" >&2; exit 1; }

# Prefer an exclusive checkpoint while writers are stopped.
# Fail closed: require process exit 0 AND inspect busy/log/checkpoint fields.
# wal_checkpoint(TRUNCATE) returns one row: busy|log|checkpointed
# - busy must be 0 (no blocking writers/readers preventing the checkpoint)
# - when log > 0, checkpointed must equal log (full checkpoint of pending frames)
# - do NOT copy until these checks pass
CKPT_OUT="$(sqlite3 "$CLAUDE_DB" "PRAGMA wal_checkpoint(TRUNCATE);")"
CKPT_RC=$?
if [[ $CKPT_RC -ne 0 ]]; then
  echo "ERROR: wal_checkpoint process failed rc=$CKPT_RC out=$CKPT_OUT" >&2
  exit 1
fi
# busy|log|checkpointed  (SQLite pipe-separated)
IFS='|' read -r CKPT_BUSY CKPT_LOG CKPT_DONE <<< "$CKPT_OUT"
if [[ -z "${CKPT_BUSY:-}" || -z "${CKPT_LOG:-}" || -z "${CKPT_DONE:-}" ]]; then
  echo "ERROR: unexpected wal_checkpoint output: $CKPT_OUT" >&2
  exit 1
fi
if [[ "$CKPT_BUSY" -ne 0 ]]; then
  echo "ERROR: wal_checkpoint busy=$CKPT_BUSY (writers/readers still active); refuse backup" >&2
  exit 1
fi
if [[ "$CKPT_LOG" -gt 0 && "$CKPT_DONE" -ne "$CKPT_LOG" ]]; then
  echo "ERROR: incomplete checkpoint log=$CKPT_LOG checkpointed=$CKPT_DONE; refuse backup" >&2
  exit 1
fi
echo "wal_checkpoint ok busy=$CKPT_BUSY log=$CKPT_LOG checkpointed=$CKPT_DONE"

cp -a "$CLAUDE_DB" "$BACKUP_DIR/cachelane.db"
# Copy sidecars if they still exist after checkpoint.
[[ -f "${CLAUDE_DB}-wal" ]] && cp -a "${CLAUDE_DB}-wal" "$BACKUP_DIR/cachelane.db-wal"
[[ -f "${CLAUDE_DB}-shm" ]] && cp -a "${CLAUDE_DB}-shm" "$BACKUP_DIR/cachelane.db-shm"

# Provenance for the backup set
{
  echo "stamp=${STAMP}"
  echo "source_db=${CLAUDE_DB}"
  echo "wal_checkpoint=${CKPT_OUT}"
  echo "repo_git_sha=$(git -C /path/to/cachelane-repo rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "installed_git_sha=$(cat /srv/cachelane/GIT_SHA 2>/dev/null || echo unknown)"
  sha256sum "$BACKUP_DIR"/cachelane.db*
} | tee "$BACKUP_DIR/MANIFEST.txt"

ls -la "$BACKUP_DIR"
```

Do not proceed without a readable backup and manifest. **Never copy after a non-zero checkpoint exit, non-zero busy, incomplete checkpoint, or malformed checkpoint output.**

## Phase 3 — Read-only preview (mandatory)

Build a **preview-only** mapping from historical hook turns to transcript assistant messages by **exact match** on:

```text
(session_id, message.id)  ==  (transcript session file stem / hook session_id, assistant message id)
```

For each candidate DB row (`turns.id` is the Anthropic/Claude message id used at insert time):

1. Locate the transcript JSONL for `session_id`.
2. Parse assistant entries with `message.usage` using the same rules as the remediated parser:
   - prefer nested `usage.cache_creation.ephemeral_*` when the nested object is present;
   - partial nested tiers must reconcile with top-level `cache_creation_input_tokens` exactly like legacy: if exactly one nested tier key is present, derive the missing tier as `max(0, total - explicit)`; if both nested tier keys are present, use both (total ignored); if the nested object is empty and total is present, use the historical 5m fallback;
   - fall back to legacy top-level tier fields only when nested `cache_creation` is absent;
   - never assign total `cache_creation_input_tokens` to the 5m bucket when explicit 1h detail exists;
   - parse string ISO timestamps with `Date.parse`; accept only finite results;
   - use one deterministic fallback timestamp for invalid/missing event times (do not call wall-clock per row during preview aggregation).
3. Classify each candidate into exactly one bucket. Classification must be **exhaustive** over the candidate set (every candidate lands in one bucket; no silent drops).

| Preview bucket | Meaning |
|---|---|
| **matched** | A single authoritative transcript usage record for `(session_id, message.id)` after the identical-record rule below, and at least one correctable field differs |
| **already-correct** | A single authoritative transcript usage record for that pair (after the identical-record rule) and all target fields already equal the repaired values |
| **unmatched** | No transcript usage entry for that pair |
| **ambiguous** | Conflicting transcript evidence for the same pair, or unreadable/partial transcript evidence (see identical-record rule) |
| **quarantine** (report only) | Candidate inventory excluded rows whose `signals` were malformed/non-array (Phase 0). Not a write class. |

### Repeated identical transcript records (required rule)

Transcript JSONL can legally contain more than one physical line for the same `message.id`. Classification must define that case explicitly:

1. Collect every assistant usage-bearing record whose message id equals the candidate `turns.id` for that `session_id`.
2. **Identical-record proof (all must hold):** for every pair of those records, the following are byte/value-equal after the same parser rules used for repair:
   - full usage object used for repair (`input`/`output`/`cache_read` and nested/legacy cache-creation tiers);
   - derived exclusive 5m/1h tier split;
   - model identifier when present on the message;
   - any other fields the repair would write from the transcript (except raw line offsets / log indices).
3. **If the identical-record proof holds:** deterministically **deduplicate by message id** to a single logical transcript record (prefer the first occurrence in file order for provenance logging only; values are the same). Proceed to **matched** or **already-correct** based on DB vs repaired values. Do **not** mark identical repeats as ambiguous.
4. **If any compared field differs:** classify as **ambiguous**. Do **not** pick a winner, average values, or "prefer latest."
5. Unreadable JSONL, partial files, or missing required usage fields that prevent the proof → **ambiguous** (or **unmatched** only when zero usage-bearing records exist for the pair).

Report at least:

```text
matched=<n>
unmatched=<n>
already_correct=<n>
ambiguous=<n>
quarantine_malformed_signals=<n>
identical_transcript_dedup_applied=<n>   # candidates collapsed from >1 identical transcript lines
```

plus a sample of each non-zero class (session id, message id, current vs proposed tiers/signals/flags/timestamps; for ambiguous, list the conflicting usage/tier/model fields).

**Hard rules for preview:**

- Preview mode must first assert the DB file exists, then open read-only (`sqlite3 "file:$CLAUDE_DB?mode=ro"` or equivalent URI/mode) and must not `UPDATE`/`INSERT`/`DELETE`. Abort if the file is missing — do not create an empty DB.
- Ambiguous, unmatched, and quarantine rows are **never** write candidates.
- Already-correct rows are listed but not rewritten.
- Deduplication by message id is allowed **only** after the identical-record proof above; otherwise the pair is ambiguous.

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
-- signals: PRESERVE all existing valid array elements; append/dedupe required markers.
-- Do NOT replace the whole signals array with a fixed two-element list.
UPDATE turns
SET
  cache_creation_5m_tokens = :parsed_5m,
  cache_creation_1h_tokens = :parsed_1h,
  cache_write_tokens       = :parsed_5m + :parsed_1h,
  cache_read_tokens        = :parsed_read,          -- only if transcript is authoritative and currently wrong
  input_tokens             = :parsed_input,         -- only if currently wrong vs transcript
  output_tokens            = :parsed_output,        -- only if currently wrong vs transcript
  effective_cost_units     = :recomputed_effective, -- from corrected token columns
  signals                  = :merged_signals_json,  -- see merge rule below
  request_mutated          = 0,
  created_at               = :parsed_created_at
WHERE id = :message_id
  AND session_id = :session_id
  -- optional defensive predicates:
  AND provider = 'anthropic';
```

### `signals` merge rule (required)

Matched rows already passed Phase 0/`json_each` validation (`signals` is a JSON array). On write:

1. Parse the existing `signals` array.
2. **Preserve every existing valid element** (order: keep first-seen order of pre-existing elements).
3. Ensure `mode:hook` is present exactly once (append only if missing).
4. Ensure `usage:recorded` is present exactly once (append only if missing).
5. Deduplicate exact string duplicates if the historical array already had them; do not invent new signal tokens beyond those two required markers.
6. Serialize back to a JSON array. Example outcomes:
   - `["mode:hook"]` → `["mode:hook","usage:recorded"]`
   - `["mode:hook","usage:recorded","other:flag"]` → unchanged (already correct set)
   - `["other:flag","mode:hook"]` → `["other:flag","mode:hook","usage:recorded"]`
   - **Forbidden:** `signals = '["mode:hook","usage:recorded"]'` as a blind replacement that drops `other:flag` or any other pre-existing element.

Rows whose `signals` are malformed/non-array remain in quarantine and are **not** updated by this procedure.

Implementation constraints:

- Update only rows present in the authorized matched set.
- Do **not** allocate new turn numbers, insert new rows, or delete rows.
- Do **not** modify LiteLLM-home databases in the same transaction.
- Do **not** replace `signals` wholesale; always merge/dedupe as above.
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
   - set of composite primary identities `(session_id, id)` unchanged (never treat bare `id` as globally unique across sessions);
   - set of `(session_id, turn_number)` pairs unchanged;
   - no new sessions introduced.

2. **Per-matched-row transcript equality (required — not aggregates alone)**
   For **every** authorized matched row, compare the post-update DB values to the transcript-derived expected values for that same composite key `(session_id, id)`:
   - `input_tokens`
   - `output_tokens`
   - `cache_read_tokens`
   - `cache_creation_5m_tokens`
   - `cache_creation_1h_tokens`
   - `effective_cost_units` (must equal the recomputed formula below, not a stale stored value)
   Any single-field mismatch on any matched row → `ROLLBACK`. Aggregate sums alone are **not** sufficient.

3. **Effective-cost formula recompute (per matched row)**
   For every matched row, recompute and assert:
   ```text
   effective_cost_units =
       input_tokens
     + 1.25 * cache_creation_5m_tokens
     + 2.0  * cache_creation_1h_tokens
     + 0.1  * cache_read_tokens
   ```
   Stored `effective_cost_units` must equal that recompute within floating-point equality used by the product (same formula as current CLI / Phase 5).

4. **Exclusive cache-creation buckets**
   - for every updated row: `cache_write_tokens = cache_creation_5m_tokens + cache_creation_1h_tokens`;
   - no negative tier columns;
   - when transcript nested 1h detail was present, 5m/1h split matches that detail (not total-only collapse into 5m).

5. **Corrected tier totals**
   - sum of `cache_creation_5m_tokens` / `cache_creation_1h_tokens` / `cache_read_tokens` over the matched set equals the transcript-derived totals for that set (in addition to the per-row checks above).

6. **Recorded usage provenance (merge-preserving)**
   - every updated row's `signals` JSON array includes both `mode:hook` and `usage:recorded` (exact elements via `json_each`, not substring match);
   - every updated row still contains **all** pre-update valid signal elements (no wholesale array replacement); only missing required markers may have been appended and exact duplicates collapsed.

7. **No-op pipeline outcome**
   - every updated row has `request_mutated = 0` (hook path does not mutate the request).

8. **Timestamp ranges**
   - every updated `created_at` is a finite epoch-ms value;
   - when the transcript timestamp was valid, `created_at` equals that parsed value exactly;
   - no updated timestamp is later than the maintenance window start solely because of wall-clock rewrite during repair (fallback timestamps, if any, must be the single deterministic fallback chosen for that repair run and recorded in the operator log).

9. **Non-candidates untouched (full set, not a sample) — composite keys only**
   - Before any write, take a **pre-write snapshot** of every non-candidate row (or rely on the Phase 2 backup DB as that snapshot). Non-candidates include: unmatched, ambiguous, already-correct, quarantine/malformed-signals, and any `provider != 'anthropic'` / non-hook rows outside the authorized matched set.
   - **Required:** full-row compare (or cryptographic checksum of the full ordered non-candidate projection) for **every** non-candidate row against that pre-write snapshot/backup — **not** a sample, **not** a partial subset, **not** spot checks alone.
   - **Identity key is composite `(session_id, id)`.** Never exclude or compare non-candidates by bare `id` alone — the same message id can exist in more than one session.
   - Practical pattern: build the matched set as rows of `(session_id, id)`, then export non-candidates with a composite exclusion, e.g.:
     ```sql
     -- matched_keys is a temp table/CTE of authorized (session_id, id) pairs
     SELECT t.*
     FROM turns t
     WHERE NOT EXISTS (
       SELECT 1 FROM matched_keys m
       WHERE m.session_id = t.session_id AND m.id = t.id
     )
     ORDER BY t.session_id, t.id;
     ```
     **Forbidden:** `WHERE id NOT IN (/* matched ids */)` — that can mark an unrelated session's row as "matched" and skip it, or fail to protect a non-candidate that shares only the message id.
   - Require byte-identical ordered dumps / matching SHA-256 over that full composite-keyed projection from the pre-write backup and from the post-update DB-in-transaction.
   - Any single non-candidate drift → `ROLLBACK`.

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
