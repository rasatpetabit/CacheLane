import Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";

export function isCorruptionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("file is not a database") ||
    msg.includes("database disk image is malformed") ||
    // Both spellings: openDatabase runs quick_check by default and
    // integrity_check under CACHELANE_FULL_INTEGRITY_CHECK. Matching only the
    // latter would mean a corrupt database detected by the default path was
    // rethrown instead of recovered.
    msg.includes("integrity_check failed") ||
    msg.includes("quick_check failed") ||
    msg.includes("sqlite_notadb") ||
    msg.includes("sqlite_corrupt")
  );
}

export function tryOpen(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}
