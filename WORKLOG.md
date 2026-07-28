# WORKLOG — cachelane

Handoff log for collaborating agents (Codex, future Claude sessions). Terse
entries: scope, key decisions, and *why* — the diff shows *what*.

## 2026-07-28 — report integrity: lossless-mode violation + headless report hang

**Scope:** removed a stray worktree, fixed two defects behind "cachelane
reporting is broken". Commit `b1b0580`.

**Stray worktree.** `/srv/dev/ai/cachelane-report-integrity` was a *linked git
worktree* on branch `fix/report-integrity`, not a random directory — but placed
as a sibling of the repo instead of under `.worktrees/`, violating the
`/srv/dev/AGENTS.md` worktree-placement rule. Every other repo under `/srv/dev`
complies; cachelane was the sole outlier. The branch was byte-identical to
`headroom-litellm-integration` (76122d5) and fully merged, so the worktree was
removed with `git worktree remove`. The branch ref is kept — it costs nothing
and removing it is not needed to satisfy the rule.

**Defect 1 — shell compressor ignored lossless mode (the real integrity bug).**
`shellCompressor` declared `supportedModes: ["lossless","balanced","aggressive"]`
but `compressShell` always returned `lossiness: "lossy"`. The `json` and `log`
compressors both degrade gracefully in lossless mode; `shell` was the only one
that did not. With the live config (`compression.mode: "lossless"`, shell
profiles on, `retention.enabled: false`) this silently mangled
`git log` / `git status` / `git diff` tool output — 406 lossy events in the local
DB, every `retention_handle` NULL and `compression_originals` empty, so the
`refetch via cachelane_expand` stub had nothing to restore from. That breaks the
non-lossy invariant asserted in CLAUDE.md.

*Why the chosen fix:* shell profiles **summarise** rather than re-encode, so
their output can never be reconstructed — there is no lossless variant to fall
back to. Passing content through untouched in lossless mode mirrors the `log`
compressor's existing idiom, so the registry keeps one consistent rule.
Regression test reproduces the exact observed corruption (three commit lines
collapsing into `76122d5 8c8c629 … (?)`).

**Defect 2 — `cachelane report` hung forever on headless hosts.** `xdg-open`
blocks rather than failing when there is no `DISPLAY`/`WAYLAND_DISPLAY`, and
`execFile`'s callback kept the stdio pipes open so Node could not exit. Now
detects headless up front, spawns detached with ignored stdio, and prints what
actually happened instead of an unconditional "opening in browser...". Report
generation went from >120 s (hang) to ~0.9 s.

**Verified:** 609 tests passed / 2 skipped, `tsc --noEmit` clean, lint clean,
build clean, and `report` exercised end-to-end without `--no-open`.

**Deployed.** `scripts/install-runtime.sh` (dry run first, then real) installed
`47ed5a9` to `/srv/cachelane`; both units restarted and active. Prior slot kept
at `/srv/cachelane.backup-20260728T200303Z`. Live round-trip confirms the fix at
the surface where it is consumed: the same `git log -12 --pretty=format:...` that
previously came back as `76122d5 8c8c629 … (?)` now returns all 12 commits
byte-intact.

**DB prune.** Deleted 57,611 `passthrough` rows with `tokens_saved <= 0` from
`compression_events`, keeping all 861 real events (247 lossless + 614 lossy) as
an audit trail. `VACUUM` + `integrity_check` clean. Note the file barely shrank:
`compression_events` was never the space driver — `turn_explanations` (~26 MB
logical) dominates, and that is live reporting data the report reads, so it was
left alone. Post-prune `stats` and `report` both verified working (902 KB,
2052 turns, 19 sessions, self-contained HTML with no external refs).

**Not done / open:**
- The 614 already-corrupted lossy events are unrecoverable (no retained
  originals). They are kept deliberately as a record of what was affected.
- `retention.enabled` is still `false`. Nothing currently backs the
  "refetch via `cachelane_expand`" promise for lossy events. In lossless mode
  nothing new becomes lossy, so this is latent — but flipping the mode to
  `balanced`/`aggressive` without enabling retention would reintroduce
  unrecoverable loss.
- Worktree placement is governed only by prose in `/srv/dev/AGENTS.md`; there is
  no deterministic control that would have prevented the stray worktree.
  Explicitly deferred this pass.
- Growth of `turn_explanations` is unbounded; no retention policy on it yet.
