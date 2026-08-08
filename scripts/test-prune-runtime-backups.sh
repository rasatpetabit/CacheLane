#!/usr/bin/env bash
# Self-contained test for scripts/prune-runtime-backups.sh.
#
# Covers the three behaviors that must not regress: no matches is a clean no-op,
# over-limit pruning keeps the NEWEST N and removes the rest, and an invalid
# KEEP aborts fail-closed (never silently skips). Runs against a /tmp fixture
# owned by the runner, so the helper's sudo-detection takes the non-sudo path
# and no passwordless sudo is required.
#
# Run: bash scripts/test-prune-runtime-backups.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/prune-runtime-backups.sh"
KEEP_MAX_DEFAULT=3

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok - $*"; }

# Make timestamps that sort the way real ones do, oldest -> newest.
mkts() { printf '2026010%dT000000Z\n' "$1"; }

# --- case 1: over-limit -> newest N kept, oldest removed ---------------------
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST"
for i in 1 2 3 4 5 6; do d="$INST.backup-$(mkts "$i")"; mkdir -p "$d"; printf 'old-%d' "$i" >"$d/marker"; done
out=$(bash "$HELPER" "$INST" 2)
# keep=2 -> 6 entries, newest 2 (i=5,6) kept, 4 (i=1..4) removed
remaining=$(ls -1d "$INST".backup-* 2>/dev/null | wc -l)
(( remaining == 2 )) || fail "over-limit: expected 2 remaining, got $remaining"
test -d "$INST.backup-$(mkts 6)" || fail "over-limit: newest (i=6) was pruned"
test -d "$INST.backup-$(mkts 5)" || fail "over-limit: 2nd-newest (i=5) was pruned"
test ! -e "$INST.backup-$(mkts 1)" || fail "over-limit: oldest (i=1) was NOT pruned"
ok "over-limit: keep=2 retains newest 2, prunes oldest 4"
rm -rf "$T"

# --- case 2: under-limit (count <= keep) -> nothing removed ------------------
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST"
for i in 1 2; do mkdir -p "$INST.backup-$(mkts "$i")"; done
bash "$HELPER" "$INST" 3 >/dev/null
remaining=$(ls -1d "$INST".backup-* 2>/dev/null | wc -l)
(( remaining == 2 )) || fail "under-limit: expected 2 remaining, got $remaining"
ok "under-limit: keep=3 with 2 entries prunes nothing"
rm -rf "$T"

# --- case 3: no matches -> clean no-op ---------------------------------------
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST"
out=$(bash "$HELPER" "$INST" 2)
[[ "$out" == *"0 backup(s) to prune"* ]] || fail "no-match: expected no-op message, got: $out"
ok "no-match: clean no-op when no backups exist"
rm -rf "$T"

# --- case 4: invalid KEEP (non-numeric) aborts fail-closed -------------------
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST" "$INST.backup-$(mkts 1)"
if bash "$HELPER" "$INST" "abc" >/tmp/prune-err 2>&1; then
  fail "invalid-keep(non-numeric): helper exited 0, expected non-zero"
fi
grep -q "must be an integer 0..3" /tmp/prune-err || fail "invalid-keep(non-numeric): wrong message: $(cat /tmp/prune-err)"
# confirm nothing was pruned despite a backup existing
test -d "$INST.backup-$(mkts 1)" || fail "invalid-keep(non-numeric): backup vanished on invalid keep"
ok "invalid-keep(non-numeric): aborts fail-closed, no pruning"
rm -rf "$T" /tmp/prune-err

# --- case 5: over-max KEEP aborts fail-closed --------------------------------
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST"
over=$((KEEP_MAX_DEFAULT + 1))
if bash "$HELPER" "$INST" "$over" >/tmp/prune-err 2>&1; then
  fail "invalid-keep(over-max): helper exited 0, expected non-zero"
fi
grep -q "exceeds KEEP_MAX\|must be an integer 0.." /tmp/prune-err || fail "invalid-keep(over-max): wrong message: $(cat /tmp/prune-err)"
ok "invalid-keep(over-max=$over): aborts fail-closed"
rm -rf "$T" /tmp/prune-err

# --- case 5b: negative KEEP (-1) aborts fail-closed -------------------------
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST" "$INST.backup-$(mkts 1)"
if bash "$HELPER" "$INST" "-1" >/tmp/prune-err 2>&1; then
  fail "invalid-keep(-1): helper exited 0, expected non-zero"
fi
grep -q "must be an integer 0.." /tmp/prune-err || fail "invalid-keep(-1): wrong message: $(cat /tmp/prune-err)"
test -d "$INST.backup-$(mkts 1)" || fail "invalid-keep(-1): backup vanished on invalid keep"
ok "invalid-keep(-1): aborts fail-closed, no pruning"
rm -rf "$T" /tmp/prune-err

# --- case 6: missing args aborts ---------------------------------------------
if bash "$HELPER" >/tmp/prune-err 2>&1; then fail "missing-args: expected non-zero"; fi
grep -q "usage:" /tmp/prune-err || fail "missing-args: wrong message"
ok "missing-args: aborts with usage"
rm -f /tmp/prune-err

# --- case 7: --validate <keep> early gate (no pruning) ----------------------
# valid values exit 0 without touching the filesystem; invalid exit 1.
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST" "$INST.backup-$(mkts 1)"
for v in 0 1 2 3; do
  bash "$HELPER" --validate "$v" >/dev/null || fail "--validate($v): valid value rejected"
done
ok "--validate: accepts each integer 0..3"
for bad in "-1" "abc" "4" ""; do
  if bash "$HELPER" --validate "$bad" >/tmp/prune-err 2>&1; then
    fail "--validate('$bad'): invalid value accepted"
  fi
done
ok "--validate: rejects -1, nonnumeric, 4, empty"
# --validate must NOT prune: the fixture backup is still there
test -d "$INST.backup-$(mkts 1)" || fail "--validate: pruned a backup (must be a pure check)"
ok "--validate: performs no pruning"
rm -rf "$T" /tmp/prune-err

# --- case 8: enumeration failure (find exits nonzero) aborts fail-closed --------
# A failing find must NOT read as "0 backups" (silent skip = the original bug).
# Inject a fake `find` that exits 1 into PATH; on a writable fixture the helper
# runs non-sudo and must abort nonzero WITHOUT pruning anything.
T=$(mktemp -d); INST="$T/cachelane"; mkdir -p "$INST" "$INST.backup-$(mkts 1)"
BIN="$T/bin"; mkdir -p "$BIN"
printf '#!/usr/bin/env bash\nexit 1\n' >"$BIN/find"; chmod +x "$BIN/find"
if PATH="$BIN:$PATH" bash "$HELPER" "$INST" 2 >/tmp/prune-err 2>&1; then
  fail "enum-failure: helper exited 0 on a failing find, expected fail-closed abort"
fi
grep -q "refusing to prune blind\|enumerating backups failed" /tmp/prune-err || fail "enum-failure: wrong message: $(cat /tmp/prune-err)"
test -d "$INST.backup-$(mkts 1)" || fail "enum-failure: backup vanished despite find failure"
ok "enum-failure: a failing find aborts fail-closed, no pruning"
rm -rf "$T" /tmp/prune-err

echo
echo "all prune-runtime-backups tests passed"
