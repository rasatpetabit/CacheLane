import type { BlockRow } from "../storage/index.js";
import type { PruneDecision } from "./types.js";

export function makeStubSummary(row: BlockRow): string {
  const handle = row.refetch_handle ?? "unknown refetch handle";
  return `${row.kind} ${handle} (${row.token_count} tokens elided)`;
}

export function formatStubText(decision: PruneDecision): string {
  // Advertise the full block id: real ids share a common "toolu_01" prefix, so
  // a truncated one is both rejected by expandStub and non-discriminating.
  const shortId = decision.block_id.slice(0, 8);
  return `[stub:${shortId}] ${decision.stub_summary} | refetch via cachelane_expand(block_id=${decision.block_id})`;
}
