import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { env, platform } from "node:process";
import type { CachelaneDb } from "../storage/index.js";
import { buildReportData } from "./query.js";
import { renderReportHtml } from "./render-html.js";
import type { ReportOptions } from "./types.js";
import type { RecordedBenchmarkReport } from "../benchmark/types.js";

export { buildReportData } from "./query.js";
export { renderReportHtml } from "./render-html.js";
export type {
  ExplanationCoverage,
  ReportData,
  ReportOptions,
  ReportSource,
  ReportTurn,
} from "./types.js";

export interface GenerateReportResult {
  out_path: string;
  /** Legacy explanation-backed detail count. */
  turns: number;
  /** Canonical recorded turn count. */
  recorded_turns?: number;
  /** Canonical completed turns rendered in the capped display window. */
  displayed_turns?: number;
  sessions: number;
}

export function generateReport(
  db: CachelaneDb,
  opts: ReportOptions,
  outPath: string,
  benchmark?: RecordedBenchmarkReport,
): GenerateReportResult {
  const data = buildReportData(db, opts);
  writeFileSync(outPath, renderReportHtml(data, benchmark), "utf8");
  return {
    out_path: outPath,
    turns: data.turns.length,
    recorded_turns: data.stats.turns,
    displayed_turns: (data.completed_turns ?? data.turns).length,
    sessions: data.sessions.length,
  };
}

/**
 * True when there is no desktop session to open a browser into. On a headless
 * Linux host `xdg-open` blocks indefinitely instead of failing, so detect the
 * case up front rather than spawning something that never returns.
 */
export function isHeadless(): boolean {
  if (platform === "darwin" || platform === "win32") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function openInBrowser(filePath: string): boolean {
  if (isHeadless()) return false;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const args = platform === "win32" ? ["", filePath] : [filePath];
  try {
    // detached + ignored stdio so the CLI can exit without waiting on the child.
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { /* best-effort; ignore errors */ });
    child.unref();
    return true;
  } catch {
    /* fail-open: never throw from opening a browser */
    return false;
  }
}
