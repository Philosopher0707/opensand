#!/usr/bin/env bash
# Every Electron launch from a desktop test or helper script must go through
# packages/desktop/test/hermetic-env.ts (hermeticElectronEnv), which sets OPENSAND_HIDDEN_WINDOW=1.
# Without it a bot or CI test opens a visible window, adds a Dock icon and steals the owner's focus.
# Usage: scripts/check-hidden-window-spawns.sh
#   HIDDEN_SPAWN_SCAN_DIRS overrides the space-separated scan roots (for the selftest).
# Exit 0 no bypasses, 1 a bypass was found, 2 a scan root is missing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${HIDDEN_SPAWN_SCAN_DIRS:-}" ]]; then
  read -r -a SCAN_DIRS <<< "$HIDDEN_SPAWN_SCAN_DIRS"
else
  SCAN_DIRS=("$ROOT/packages/desktop/test" "$ROOT/scripts")
fi

SPAWN_RE='spawn\([^,]*electron|fork\([^,]*electron'
APP_LAUNCH_RE='"\$EXEC_PATH"'

FAILED=0
CHECKED=0
for dir in "${SCAN_DIRS[@]}"; do
  if [[ ! -d "$dir" ]]; then
    echo "FAIL: scan directory not found: $dir" >&2
    exit 2
  fi
  while IFS= read -r -d '' file; do
    CHECKED=$((CHECKED + 1))
    case "$file" in
      *.ts|*.js|*.mjs|*.cjs)
        if hits=$(grep -nE "$SPAWN_RE" "$file"); then
          if ! grep -q 'hermeticElectronEnv' "$file"; then
            echo "FAIL: Electron spawn without hermeticElectronEnv in ${file#$ROOT/}:" >&2
            echo "$hits" >&2
            echo "  build the child env with hermeticElectronEnv() from packages/desktop/test/hermetic-env.ts" >&2
            FAILED=1
          fi
        fi
        ;;
      *.sh)
        # Packaged-app smoke launches cannot import the TS helper; require a hidden/smoke flag.
        if grep -qE "$APP_LAUNCH_RE" "$file"; then
          if ! grep -qE 'OPENSAND_HIDDEN_WINDOW=1|OPENSAND_SMOKE=1' "$file"; then
            echo "FAIL: packaged app launched without OPENSAND_HIDDEN_WINDOW=1 (or OPENSAND_SMOKE=1) in ${file#$ROOT/}" >&2
            FAILED=1
          fi
        fi
        ;;
    esac
  done < <(find "$dir" -maxdepth 2 -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.sh' \) -print0)
done

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
echo "PASS: all $CHECKED file(s) launch Electron hidden (no visible window, Dock icon or focus steal)."
exit 0
