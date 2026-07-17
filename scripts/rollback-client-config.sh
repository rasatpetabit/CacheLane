#!/usr/bin/env bash
# Restore Pi + Claude Code client config from pre-cachelane backups (proxy units stay up).
set -euo pipefail
TS="${1:-}"
pick_latest() {
  local pattern="$1"
  # shellcheck disable=SC2086
  ls -1t $pattern 2>/dev/null | head -1 || true
}

PI_MODELS=$(pick_latest "$HOME/.pi/agent/models.json.bak-pre-cachelane-*")
PI_SETTINGS=$(pick_latest "$HOME/.pi/agent/settings.json.bak-pre-*")
CC_SETTINGS=$(pick_latest "$HOME/.claude/settings.json.bak-pre-cachelane-*")
# prefer bak-pre-cc-cachelane if present
CC_SETTINGS2=$(pick_latest "$HOME/.claude/settings.json.bak-pre-cc-cachelane-*")
[[ -n "$CC_SETTINGS2" ]] && CC_SETTINGS="$CC_SETTINGS2"

echo "Pi models backup:   ${PI_MODELS:-NONE}"
echo "Pi settings backup: ${PI_SETTINGS:-NONE}"
echo "CC settings backup: ${CC_SETTINGS:-NONE}"

if [[ -z "$PI_MODELS" && -z "$CC_SETTINGS" ]]; then
  echo "No backups found; aborting" >&2
  exit 1
fi

if [[ "${DRY_RUN:-1}" == "1" ]]; then
  echo "DRY_RUN=1 (default). Set DRY_RUN=0 to apply."
  exit 0
fi

[[ -n "$PI_MODELS" ]] && cp -a "$PI_MODELS" "$HOME/.pi/agent/models.json" && echo "restored models.json"
[[ -n "$PI_SETTINGS" ]] && cp -a "$PI_SETTINGS" "$HOME/.pi/agent/settings.json" && echo "restored settings.json"
if [[ -n "$CC_SETTINGS" ]]; then
  cp -a "$CC_SETTINGS" "$HOME/.claude/settings.json"
  echo "restored claude settings.json"
fi
# Optional: stop pointing CC at cachelane if restored backup lacks BASE_URL
echo "Rollback applied. Restart Pi/Claude Code sessions to pick up config."
echo "Proxy units left running; stop with: systemctl stop cachelane-litellm cachelane-claude"
