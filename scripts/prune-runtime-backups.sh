#!/usr/bin/env bash
# Prune `<install>.backup-<ts>` runtime snapshots to a bounded keep-N, and/or
# validate a keep value.
#
# Extracted from install-runtime.sh so the deploy and its tests share ONE
# fail-closed implementation. The bounded rollback history is the only thing
# that belongs beside a production install; without pruning, every deploy drops
# another full snapshot forever (the cachelane deploy left 24 dirs / 1.5 GB).
# See /srv/AGENTS.md "No backup trash in production roots".
#
# Usage:
#   prune-runtime-backups.sh --validate <keep>
#       Exit 0 iff <keep> is an integer in 0..KEEP_MAX; exit 1 otherwise.
#       No pruning. install-runtime.sh calls this BEFORE creating a backup so a
#       bad value aborts before any mutation.
#   prune-runtime-backups.sh <install_dir> <keep>
#       Validate <keep> (same gate), then prune `<install>.backup-*` siblings to
#       the newest <keep>, removing the rest. Requires sudo when the parent of
#       <install_dir> is not writable by the runner (production /srv is
#       root-owned); a test fixture in /tmp owned by the runner does not.
#
# KEEP_MAX is a hard constant. Do not raise it to silence a violation; add a
# bounded prune in the generator instead. Fail-closed: an out-of-range <keep>
# ABORTS (exit 1) rather than silently skipping the prune -- pruning is the only
# thing stopping snapshots from accumulating, and silently disabling it on a typo
# is exactly the original bug.
set -euo pipefail

KEEP_MAX=3  # hard cap; the single source of truth for the keep range

fail() { echo "prune-runtime-backups: $*" >&2; exit 1; }

# valid_keep <k>: return 0 iff <k> is a non-negative integer <= KEEP_MAX.
# Regex first so the arithmetic never sees garbage (and `(( ))` cannot error).
valid_keep() {
  local k="$1"
  [[ "$k" =~ ^[0-9]+$ ]] || return 1
  (( k <= KEEP_MAX )) || return 1
}

# --- --validate <keep>: early gate, no pruning -------------------------------
if [[ "${1:-}" == "--validate" ]]; then
  k="${2:-}"
  if valid_keep "$k"; then
    exit 0
  fi
  echo "prune-runtime-backups: KEEP must be an integer 0..${KEEP_MAX}, got: '${k}'" >&2
  exit 1
fi

# --- <install_dir> <keep>: validate + prune ----------------------------------
INSTALL="${1:-}"
KEEP="${2:-}"
[[ -n "$INSTALL" ]] || fail "usage: $0 <install_dir> <keep>  (or: $0 --validate <keep>)"
valid_keep "$KEEP" || fail "KEEP must be an integer 0..${KEEP_MAX}, got: '${KEEP}'"

parent="$(dirname -- "$INSTALL")"
base="$(basename -- "$INSTALL")"
# sudo only when the parent is not writable by this account: production (/srv is
# root-owned) needs root to unlink entries; a /tmp fixture owned by the runner
# does not, and must not require passwordless sudo.
if [[ -w "$parent" ]]; then FIND=(find) RM=(rm); else FIND=(sudo find) RM=(sudo rm); fi

# Enumerate snapshots newest-first, capturing enumeration failure: a find/sudo
# error must NOT read as "0 backups" (that would silently skip pruning -- the
# exact defect this script exists to prevent). pipefail makes the find|sort pipe
# return nonzero if either leg fails; the command-substitution `||` turns that
# into a hard abort BEFORE any prune path is derived.
enum=$("${FIND[@]}" "$parent" -maxdepth 1 -name "${base}.backup-*" -type d \
  -printf '%T@ %p\n' 2>/dev/null | sort -rn) \
  || fail "enumerating backups failed (status $?) under $parent -- refusing to prune blind"
_all=()
[[ -n "$enum" ]] && mapfile -t _all <<< "$enum"
# Derive the prune set (positions KEEP..end, newest-first) in PURE bash, so no
# later external command can mask an error. Each line is "<mtime> <path>";
# ${line#* } drops the leading mtime, preserving the path (and any spaces in it).
_prune=()
for (( i=KEEP; i<${#_all[@]}; i++ )); do
  _prune+=( "${_all[i]#* }" )
done

if (( ${#_prune[@]} > 0 )); then
  echo "prune-runtime-backups: removing ${#_prune[@]} backup(s) older than keep=$KEEP under $parent"
  "${RM[@]}" -rf -- "${_prune[@]}"
else
  echo "prune-runtime-backups: 0 backup(s) to prune (keep=$KEEP)"
fi
