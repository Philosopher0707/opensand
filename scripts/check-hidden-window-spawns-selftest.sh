#!/usr/bin/env bash
# Hermetic selftest for scripts/check-hidden-window-spawns.sh (no Electron is launched).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${HIDDEN_SPAWN_GATE:-$SCRIPT_DIR/check-hidden-window-spawns.sh}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-hidden-spawn-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

LAST_OUT=""
LAST_STATUS=0
run_gate() {
  LAST_OUT="$(HIDDEN_SPAWN_SCAN_DIRS="$1" bash "$GATE" 2>&1)"
  LAST_STATUS=$?
}
expect() { # <status> <substring|-> <name> <scan-dir>
  local want_status="$1" want_text="$2" name="$3" dir="$4"
  run_gate "$dir"
  if [[ "$LAST_STATUS" -ne "$want_status" ]]; then
    fail "$name (exit $LAST_STATUS, want $want_status): $LAST_OUT"
    return
  fi
  if [[ "$want_text" != "-" ]] && ! grep -qF -- "$want_text" <<<"$LAST_OUT"; then
    fail "$name (missing '$want_text'): $LAST_OUT"
    return
  fi
  pass "$name"
}

# A direct Electron spawn with no shared env helper is the regression we must catch.
mkdir -p "$TMP_DIR/bad-ts"
cat > "$TMP_DIR/bad-ts/rogue.test.ts" <<'EOF'
const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { env: process.env });
EOF
expect 1 "hermeticElectronEnv" "raw Electron spawn is refused" "$TMP_DIR/bad-ts"

# The same spawn built from the helper is allowed.
mkdir -p "$TMP_DIR/good-ts"
cat > "$TMP_DIR/good-ts/ok.test.ts" <<'EOF'
import { hermeticElectronEnv } from "./hermetic-env.js";
const env = hermeticElectronEnv(home);
const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { env });
EOF
expect 0 "PASS" "helper-built Electron spawn is allowed" "$TMP_DIR/good-ts"

# A fork of Electron is refused too.
mkdir -p "$TMP_DIR/bad-fork"
cat > "$TMP_DIR/bad-fork/rogue.test.js" <<'EOF'
const child = fork(electronBinary, [runner], { env: process.env });
EOF
expect 1 "hermeticElectronEnv" "raw Electron fork is refused" "$TMP_DIR/bad-fork"

# Packaged-app shell launches must opt into hidden/smoke mode.
mkdir -p "$TMP_DIR/bad-sh"
cat > "$TMP_DIR/bad-sh/smoke.sh" <<'EOF'
"$EXEC_PATH" > "$LOG_FILE" 2>&1 &
EOF
expect 1 "OPENSAND_HIDDEN_WINDOW=1" "packaged app launch without hidden flag is refused" "$TMP_DIR/bad-sh"

mkdir -p "$TMP_DIR/good-sh"
cat > "$TMP_DIR/good-sh/smoke.sh" <<'EOF'
OPENSAND_HIDDEN_WINDOW=1 \
"$EXEC_PATH" > "$LOG_FILE" 2>&1 &
EOF
expect 0 "PASS" "packaged app launch with hidden flag is allowed" "$TMP_DIR/good-sh"

# Missing scan root is a hard error, not a silent pass.
expect 2 "scan directory not found" "missing scan root is refused" "$TMP_DIR/does-not-exist"

# The checked-in tree itself passes.
LAST_OUT="$(bash "$GATE" 2>&1)"
LAST_STATUS=$?
if [[ "$LAST_STATUS" -ne 0 ]]; then
  fail "real tree passes the gate (exit $LAST_STATUS): $LAST_OUT"
else
  pass "real tree passes the gate"
fi

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
echo "check-hidden-window-spawns-selftest: ok"
exit 0
