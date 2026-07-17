-- Session-scoped block identity: tool_call_id may collide across sessions.
-- Rebuild blocks with PRIMARY KEY (session_id, id). Drop FK on
-- block_references.block_id (turn implies session; refs remain soft).

PRAGMA foreign_keys = OFF;

CREATE TABLE blocks_new (
  id              TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  volatility      TEXT NOT NULL,
  is_pinned       INTEGER NOT NULL DEFAULT 0,
  token_count     INTEGER NOT NULL,
  added_at_turn   INTEGER NOT NULL,
  last_referenced_at_turn INTEGER NOT NULL,
  unused_turns    INTEGER NOT NULL DEFAULT 0,
  is_stub         INTEGER NOT NULL DEFAULT 0,
  stub_summary    TEXT,
  refetch_handle  TEXT,
  restored_at_turn INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);

-- Prefer the newest row when historical global-id collisions exist.
INSERT INTO blocks_new (
  id, workspace_id, session_id, content_hash, kind, volatility,
  is_pinned, token_count, added_at_turn, last_referenced_at_turn,
  unused_turns, is_stub, stub_summary, refetch_handle,
  restored_at_turn, created_at, updated_at
)
SELECT
  id, workspace_id, session_id, content_hash, kind, volatility,
  is_pinned, token_count, added_at_turn, last_referenced_at_turn,
  unused_turns, is_stub, stub_summary, refetch_handle,
  restored_at_turn, created_at, updated_at
FROM blocks
WHERE rowid IN (
  SELECT MAX(rowid) FROM blocks GROUP BY session_id, id
);

DROP TABLE blocks;
ALTER TABLE blocks_new RENAME TO blocks;

CREATE INDEX IF NOT EXISTS idx_blocks_session ON blocks(workspace_id, session_id);
CREATE INDEX IF NOT EXISTS idx_blocks_hash    ON blocks(content_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_unused  ON blocks(unused_turns) WHERE is_stub = 0;
CREATE INDEX IF NOT EXISTS idx_blocks_id      ON blocks(id);

-- Soften block_references FK: block_id alone is no longer a unique parent key.
CREATE TABLE block_references_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id        TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  reference_type  TEXT NOT NULL,
  evidence        TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

INSERT INTO block_references_new (id, block_id, turn_id, reference_type, evidence, created_at)
SELECT id, block_id, turn_id, reference_type, evidence, created_at FROM block_references;

DROP TABLE block_references;
ALTER TABLE block_references_new RENAME TO block_references;

CREATE INDEX IF NOT EXISTS idx_refs_block ON block_references(block_id);
CREATE INDEX IF NOT EXISTS idx_refs_turn  ON block_references(turn_id);

PRAGMA foreign_keys = ON;
