#!/usr/bin/env bash
# Linux packaged .deb smoke test
# Usage:
#   scripts/smoke-linux.sh <path/to/OpenSand*.deb>
#
# Extracts a Linux .deb into a fresh temp dir, derives the packaged executable
# from its .desktop entry (no eval), rejects any Mach-O content, launches the
# packaged binary under xvfb with isolated state, and asserts that
# GET /api/diagnostics reports the bundled version. Prints:
#   OpenSand <version> linux ok
# A wrong version, a Mach-O binary, an early exit or a missing port file is a
# hard failure. No repo/runtime fallback is used.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEB_PATH="${1:-}"
if [[ -z "$DEB_PATH" || ! -f "$DEB_PATH" ]]; then
  echo "smoke-linux error: no .deb specified or not a file" >&2
  exit 1
fi

# Override points let the hermetic selftest supply fake dpkg-deb/xvfb/curl
# fixtures without root, a display or a downloaded package.
DPKG_DEB="${OPENSAND_DPKG_DEB:-dpkg-deb}"
XVFB_RUN="${OPENSAND_XVFB_RUN:-xvfb-run}"
CURL_BIN="${OPENSAND_CURL:-curl}"
STARTUP_TIMEOUT="${OPENSAND_SMOKE_STARTUP_TIMEOUT_SECONDS:-60}"

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi
run_bounded() {
  local secs="$1"; shift
  if [[ -n "$TIMEOUT_BIN" ]]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}
SETSID_BIN=""
if command -v setsid >/dev/null 2>&1; then SETSID_BIN="setsid"; fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-smoke-linux.XXXXXX")
EXTRACT_DIR="$WORK/extracted"
HOME_DIR="$WORK/home"
OPENSAND_HOME_DIR="$WORK/opensand-home"
USER_DATA_DIR="$WORK/user-data"
STATE_DIR="$WORK/state"
LOG_FILE="$WORK/app.log"
mkdir -p "$EXTRACT_DIR" "$HOME_DIR" "$OPENSAND_HOME_DIR" "$USER_DATA_DIR" "$STATE_DIR"

APP_PID=""
TOKEN=""
print_log() {
  if [[ -n "$TOKEN" ]]; then
    sed "s/${TOKEN}/[REDACTED]/g" "$LOG_FILE" >&2 2>/dev/null || true
  else
    cat "$LOG_FILE" >&2 2>/dev/null || true
  fi
}

cleanup() {
  local rc=$?
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM -- "-$APP_PID" 2>/dev/null || kill -TERM "$APP_PID" 2>/dev/null || true
    for ((step=0; step<30; step++)); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL -- "-$APP_PID" 2>/dev/null || kill -KILL "$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  exit $rc
}
trap cleanup EXIT INT TERM

fail() {
  echo "smoke-linux error: $*" >&2
  exit 1
}

# --- Extract and read the bundle version ---
run_bounded 180 "$DPKG_DEB" -x "$DEB_PATH" "$EXTRACT_DIR" >/dev/null 2>&1 \
  || fail "dpkg-deb -x failed for $DEB_PATH"
BUNDLE_VERSION=$(run_bounded 30 "$DPKG_DEB" -f "$DEB_PATH" Version 2>/dev/null | tr -d '\r\n' || true)
[[ -n "$BUNDLE_VERSION" ]] || fail "could not read bundle version from $DEB_PATH"

# --- Reject any Mach-O content in the extracted package ---
macho_magic() {
  local magic
  magic=$(LC_ALL=C head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)
  case "$magic" in
    cafebabe|bebafeca|cafebabf|bfbafeca|feedface|cefaedfe|feedfacf|cffaedfe) return 0 ;;
  esac
  return 1
}
while IFS= read -r -d '' file; do
  if macho_magic "$file"; then
    fail "Mach-O content found in package: ${file#$EXTRACT_DIR/}"
  fi
done < <(find "$EXTRACT_DIR" -type f -print0 2>/dev/null)

# --- Derive the executable from the packaged .desktop entry (no eval) ---
DESKTOP_FILE=$(find "$EXTRACT_DIR" -type f -name '*.desktop' -print 2>/dev/null | head -n 1 || true)
[[ -n "$DESKTOP_FILE" ]] || fail "no .desktop entry found in $DEB_PATH"
EXEC_LINE=$(grep -m1 '^Exec=' "$DESKTOP_FILE" 2>/dev/null || true)
EXEC_VALUE=${EXEC_LINE#Exec=}
EXEC_VALUE=${EXEC_VALUE%% *}       # first token only
EXEC_VALUE=${EXEC_VALUE%%%*}       # drop an attached %U/%F field code
EXEC_VALUE=${EXEC_VALUE//\"/}      # drop surrounding quotes
[[ -n "$EXEC_VALUE" ]] || fail "empty Exec in .desktop entry"
APP_BIN="$EXTRACT_DIR/${EXEC_VALUE#/}"
[[ -f "$APP_BIN" && -x "$APP_BIN" ]] || fail "packaged executable not found: ${EXEC_VALUE}"

echo "smoke-linux: package $DEB_PATH, version $BUNDLE_VERSION, executable ${EXEC_VALUE}"

# --- Launch only the packaged binary under xvfb with isolated state ---
# --no-sandbox: dpkg-deb -x does not install chrome-sandbox as root:setuid, so
# Electron's setuid sandbox cannot start from an extracted test package.
launch_app() {
  if [[ -n "$SETSID_BIN" ]]; then
    exec env -u ELECTRON_RUN_AS_NODE \
      HOME="$HOME_DIR" OPENSAND_HOME="$OPENSAND_HOME_DIR" \
      XDG_CONFIG_HOME="$HOME_DIR/.config" XDG_DATA_HOME="$HOME_DIR/.local/share" \
      OPENSAND_STATE_DIR="$STATE_DIR" OPENSAND_SMOKE=1 \
      "$SETSID_BIN" "$XVFB_RUN" -a "$APP_BIN" --no-sandbox
  fi
  exec env -u ELECTRON_RUN_AS_NODE \
    HOME="$HOME_DIR" OPENSAND_HOME="$OPENSAND_HOME_DIR" \
    XDG_CONFIG_HOME="$HOME_DIR/.config" XDG_DATA_HOME="$HOME_DIR/.local/share" \
    OPENSAND_STATE_DIR="$STATE_DIR" OPENSAND_SMOKE=1 \
    "$XVFB_RUN" -a "$APP_BIN" --no-sandbox
}
launch_app >"$LOG_FILE" 2>&1 &
APP_PID=$!

# --- Wait (bounded) for port and token; never print the token ---
PORT=""
deadline=$(( $(date +%s) + STARTUP_TIMEOUT ))
while :; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    print_log
    fail "packaged app exited before writing server.port/token"
  fi
  if [[ -f "$STATE_DIR/server.port" && -z "$PORT" ]]; then
    PORT=$(tr -d '\r\n' < "$STATE_DIR/server.port" || true)
  fi
  if [[ -f "$STATE_DIR/server.token" && -z "$TOKEN" ]]; then
    TOKEN=$(tr -d '\r\n' < "$STATE_DIR/server.token" || true)
  fi
  if [[ -n "$PORT" && -n "$TOKEN" ]]; then break; fi
  if (( $(date +%s) >= deadline )); then
    print_log
    fail "timed out after ${STARTUP_TIMEOUT}s waiting for server.port/token"
  fi
  sleep 0.25
done
[[ -n "$PORT" ]] || fail "server.port was not written"
echo "smoke-linux: app answered on local port $PORT with an active token"

# --- Query diagnostics with the token and require the bundle version ---
RESP=$(run_bounded 20 "$CURL_BIN" -s -w '\nHTTP_STATUS:%{http_code}' \
  -H "Authorization: Bearer $TOKEN" --connect-timeout 5 --max-time 10 \
  "http://127.0.0.1:$PORT/api/diagnostics" 2>/dev/null || true)
HTTP_CODE=$(printf '%s\n' "$RESP" | grep 'HTTP_STATUS:' | cut -d: -f2 | tr -d '\r' || true)
BODY=$(printf '%s\n' "$RESP" | sed '/HTTP_STATUS:/d')
[[ "$HTTP_CODE" == "200" ]] || fail "GET /api/diagnostics returned HTTP '$HTTP_CODE'"
REPORTED=$(printf '%s' "$BODY" | node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(String(d && (d.data && d.data.app || d.appVersion) || ""));
  } catch { process.stdout.write(""); }
' 2>/dev/null || true)
[[ -n "$REPORTED" ]] || fail "diagnostics did not report a version"
[[ "$REPORTED" == "$BUNDLE_VERSION" ]] \
  || fail "version mismatch: diagnostics reported '$REPORTED', bundle is '$BUNDLE_VERSION'"

echo "OpenSand $BUNDLE_VERSION linux ok"
exit 0
