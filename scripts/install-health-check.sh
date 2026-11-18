#!/usr/bin/env bash
# Post-install health check: prove an installed OpenSand app starts and answers.
# Usage:
#   scripts/install-health-check.sh <path/to/OpenSand.app> <expected-version>
#
# Launches the installed bundle's own binary in smoke mode with a fresh, isolated state
# dir, waits for it to publish its local server port and token, queries GET /api/diagnostics
# over that local API, checks the reported version, then terminates exactly the launched
# process and removes the temporary state. It never uses ~/.opensand as its state dir and
# fails closed if ~/.opensand changes while the check runs.
set -euo pipefail

APP_PATH="${1:-}"
EXPECTED_VERSION="${2:-}"

if [[ -z "$APP_PATH" || -z "$EXPECTED_VERSION" ]]; then
  echo "FAIL: usage: scripts/install-health-check.sh <path/to/OpenSand.app> <expected-version>" >&2
  exit 1
fi

EXEC_PATH="$APP_PATH/Contents/MacOS/OpenSand"
if [[ ! -x "$EXEC_PATH" ]]; then
  echo "FAIL: installed app executable not found or not executable: $EXEC_PATH" >&2
  exit 1
fi

TIMEOUT_SECONDS="${OPENSAND_HEALTH_TIMEOUT_SECONDS:-30}"

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-health.XXXXXX")
STATE_DIR="$WORK_DIR/state"
LOG_FILE="$WORK_DIR/app.log"
mkdir -p "$STATE_DIR"

# The check must never use the user's real state directory.
if [[ "$STATE_DIR" == "$HOME/.opensand" || "$APP_PATH" == "$HOME/.opensand" ]]; then
  echo "FAIL: health check refuses the user's real state directory" >&2
  rm -rf "$WORK_DIR"
  exit 1
fi

USER_STATE_DIR="$HOME/.opensand"
USER_STATE_MTIME=""
if [[ -d "$USER_STATE_DIR" ]]; then
  USER_STATE_MTIME=$(stat -f "%m" "$USER_STATE_DIR" 2>/dev/null || stat -c "%Y" "$USER_STATE_DIR" 2>/dev/null || echo "")
fi

APP_PID=""
cleanup() {
  local exit_code=$?
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    for ((step=1; step<=20; step++)); do
      if ! kill -0 "$APP_PID" 2>/dev/null; then break; fi
      sleep 0.1
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -9 "$APP_PID" 2>/dev/null || true
      wait "$APP_PID" 2>/dev/null || true
    fi
  fi
  if [[ -n "$USER_STATE_MTIME" && -d "$USER_STATE_DIR" ]]; then
    local current_mtime
    current_mtime=$(stat -f "%m" "$USER_STATE_DIR" 2>/dev/null || stat -c "%Y" "$USER_STATE_DIR" 2>/dev/null || echo "")
    if [[ "$current_mtime" != "$USER_STATE_MTIME" ]]; then
      echo "FAIL: health check modified $USER_STATE_DIR (state isolation broken)" >&2
      exit_code=1
    fi
  fi
  rm -rf "$WORK_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "install-health-check: launching installed app: $EXEC_PATH"
echo "install-health-check: isolated state dir: $STATE_DIR"
env -u ELECTRON_RUN_AS_NODE \
    OPENSAND_STATE_DIR="$STATE_DIR" \
    OPENSAND_SMOKE=1 \
    "$EXEC_PATH" > "$LOG_FILE" 2>&1 &
APP_PID=$!

PORT=""
TOKEN=""
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
while (( $(date +%s) < DEADLINE )); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "FAIL: installed app (pid $APP_PID) exited before answering" >&2
    echo "--- App Log ---" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  if [[ -f "$STATE_DIR/server.token" && -z "$TOKEN" ]]; then
    TOKEN=$(tr -d '\r\n' < "$STATE_DIR/server.token")
  fi
  if [[ -f "$STATE_DIR/server.port" && -z "$PORT" ]]; then
    PORT=$(tr -d '\r\n' < "$STATE_DIR/server.port")
  fi
  if [[ -n "$PORT" && -n "$TOKEN" ]]; then
    break
  fi
  sleep 0.2
done

if [[ -z "$PORT" || -z "$TOKEN" ]]; then
  echo "FAIL: installed app did not publish its server port and token within ${TIMEOUT_SECONDS}s" >&2
  echo "--- App Log ---" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

DIAG_URL="http://127.0.0.1:$PORT/api/diagnostics"
echo "install-health-check: querying GET $DIAG_URL"
HTTP_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  --connect-timeout 3 \
  --max-time 5 \
  "$DIAG_URL" || true)
HTTP_CODE=$(printf '%s\n' "$HTTP_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
JSON_BODY=$(printf '%s\n' "$HTTP_RESP" | sed '/HTTP_STATUS:/d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "FAIL: GET /api/diagnostics returned HTTP $HTTP_CODE (expected 200)" >&2
  echo "Response: $JSON_BODY" >&2
  exit 1
fi

REPORTED_VERSION=$(printf '%s\n' "$JSON_BODY" | node -e '
const fs = require("fs");
let raw = fs.readFileSync(0, "utf8");
let d = {};
try { d = JSON.parse(raw); } catch {}
console.log((d && (d.data && d.data.app || d.appVersion)) || "");
' 2>/dev/null || echo "")
echo "install-health-check: app reported version '$REPORTED_VERSION'"

if [[ "$REPORTED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "FAIL: installed app version '$REPORTED_VERSION' does not match expected '$EXPECTED_VERSION'" >&2
  exit 1
fi

echo "install-health-check: OK - installed app starts and answers with version '$REPORTED_VERSION'"
exit 0
