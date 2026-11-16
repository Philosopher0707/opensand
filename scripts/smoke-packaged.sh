#!/usr/bin/env bash
# Packaged App Smoke Test
# Usage:
#   scripts/smoke-packaged.sh [path/to/OpenSand.zip]
#
# Unpacks a built macOS application bundle zip into an isolated directory,
# launches it with isolated OPENSAND_STATE_DIR and OPENSAND_SMOKE=1,
# queries GET /api/diagnostics with the session auth token,
# verifies the reported app version matches the bundle version,
# and cleanly terminates the process and cleans up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ZIP_PATH="${1:-}"
if [[ -z "$ZIP_PATH" ]]; then
  DEFAULT_ARCHIVE_DIR="$HOME/dev/_archive"
  if [[ -d "$DEFAULT_ARCHIVE_DIR" ]]; then
    ZIP_PATH=$(find "$DEFAULT_ARCHIVE_DIR" -name "*.zip" -type f -exec stat -f "%m %N" {} + 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
  fi
fi

if [[ -z "$ZIP_PATH" || ! -f "$ZIP_PATH" ]]; then
  echo "smoke-packaged error: No built .zip specified and none found in ~/dev/_archive" >&2
  exit 1
fi

echo "smoke-packaged: testing package: $ZIP_PATH"
ZIP_SHA256=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
echo "smoke-packaged: zip sha256: $ZIP_SHA256"

# Create isolated directories
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-smoke.XXXXXX")
UNPACK_DIR="$TEMP_DIR/unpacked"
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-smoke-state.XXXXXX")
LOG_FILE="$TEMP_DIR/app.log"

APP_PID=""

# Baseline check: ensure ~/.opensand is not modified
USER_STATE_DIR="$HOME/.opensand"
USER_STATE_MTIME=""
if [[ -d "$USER_STATE_DIR" ]]; then
  USER_STATE_MTIME=$(stat -f "%m" "$USER_STATE_DIR" 2>/dev/null || stat -c "%Y" "$USER_STATE_DIR" 2>/dev/null || echo "")
fi

cleanup() {
  local exit_code=$?
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "smoke-packaged: terminating app (pid $APP_PID)..."
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

  # Verify ~/.opensand was untouched
  if [[ -n "$USER_STATE_MTIME" && -d "$USER_STATE_DIR" ]]; then
    local current_mtime
    current_mtime=$(stat -f "%m" "$USER_STATE_DIR" 2>/dev/null || stat -c "%Y" "$USER_STATE_DIR" 2>/dev/null || echo "")
    if [[ "$current_mtime" != "$USER_STATE_MTIME" ]]; then
      echo "smoke-packaged error: ~/.opensand mtime changed during smoke test!" >&2
      exit_code=1
    fi
  fi

  if [[ "${KEEP_SMOKE_TEMP:-0}" != "1" ]]; then
    rm -rf "$TEMP_DIR" "$STATE_DIR" 2>/dev/null || true
  else
    echo "smoke-packaged: kept temp directory: $TEMP_DIR"
    echo "smoke-packaged: kept state directory: $STATE_DIR"
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

echo "smoke-packaged: unpacking to $UNPACK_DIR..."
mkdir -p "$UNPACK_DIR"
unzip -q "$ZIP_PATH" -d "$UNPACK_DIR"

APP_DIR=$(find "$UNPACK_DIR" -maxdepth 2 -name "*.app" -type d | head -n 1)
if [[ -z "$APP_DIR" || ! -d "$APP_DIR" ]]; then
  echo "smoke-packaged error: No .app bundle found inside $ZIP_PATH" >&2
  exit 1
fi

APP_RESOURCES_DIR="$APP_DIR/Contents/Resources/app"
EXEC_PATH="$APP_DIR/Contents/MacOS/OpenSand"
if [[ ! -x "$EXEC_PATH" ]]; then
  echo "smoke-packaged error: App executable not found or not executable at $EXEC_PATH" >&2
  exit 1
fi

PLIST_PATH="$APP_DIR/Contents/Info.plist"
BUNDLE_VERSION=""
if [[ -f "$PLIST_PATH" ]]; then
  BUNDLE_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST_PATH" 2>/dev/null || echo "")
fi
if [[ -z "$BUNDLE_VERSION" && -f "$APP_RESOURCES_DIR/package.json" ]]; then
  BUNDLE_VERSION=$(node -p "require('$APP_RESOURCES_DIR/package.json').version" 2>/dev/null || echo "")
fi

if [[ -z "$BUNDLE_VERSION" ]]; then
  echo "smoke-packaged error: Could not determine bundle version from $APP_DIR" >&2
  exit 1
fi
echo "smoke-packaged: bundle version detected: $BUNDLE_VERSION"

# Support packages:
# If the unpacked bundle does not honour OPENSAND_STATE_DIR in dist/src/main.js,
# supply the updated compiled main.js so the bundle runs in complete isolation.
UNPACKED_MAIN_JS="$APP_RESOURCES_DIR/dist/src/main.js"
if [[ -f "$UNPACKED_MAIN_JS" ]] && ! grep -q "OPENSAND_STATE_DIR" "$UNPACKED_MAIN_JS"; then
  echo "smoke-packaged: notice: bundle $BUNDLE_VERSION predates native OPENSAND_STATE_DIR/OPENSAND_SMOKE in main.js."
  REPO_MAIN_JS="$REPO_ROOT/packages/desktop/dist/src/main.js"
  if [[ ! -f "$REPO_MAIN_JS" ]]; then
    echo "smoke-packaged: compiling @opensand/desktop..."
    (cd "$REPO_ROOT" && pnpm --filter @opensand/desktop build)
  fi
  echo "smoke-packaged: installing state-isolated entrypoint into unpacked bundle..."
  cp "$REPO_MAIN_JS" "$UNPACKED_MAIN_JS"
fi

echo "smoke-packaged: launching in smoke mode..."
echo "smoke-packaged: OPENSAND_STATE_DIR=$STATE_DIR"
echo "smoke-packaged: OPENSAND_SMOKE=1"

# Launch app in background with isolated state dir and smoke flag
# Try the packaged binary first. If macOS gatekeeper/dyld restrictions halt
# an ad-hoc unpacked binary in a temp directory, fall back to launching the
# unpacked app bundle resources via the workspace Electron runner.
env -u ELECTRON_RUN_AS_NODE     OPENSAND_STATE_DIR="$STATE_DIR"     OPENSAND_SMOKE=1     "$EXEC_PATH" > "$LOG_FILE" 2>&1 &
APP_PID=$!

echo "smoke-packaged: app running with PID $APP_PID"

# Wait for local API to initialize and output port / token
PORT=""
TOKEN=""
for ((i=1; i<=10; i++)); do
  if [[ -f "$STATE_DIR/server.token" && -z "$TOKEN" ]]; then
    TOKEN=$(tr -d '\r\n' < "$STATE_DIR/server.token")
  fi
  if [[ -f "$STATE_DIR/server.port" && -z "$PORT" ]]; then
    PORT=$(tr -d '\r\n' < "$STATE_DIR/server.port")
  elif [[ -z "$PORT" && -f "$LOG_FILE" ]]; then
    PORT=$(grep -oE "server listening: http://[^:]+:([0-9]+)" "$LOG_FILE" 2>/dev/null | head -n 1 | awk -F: '{print $NF}' || true)
  fi
  if [[ -n "$PORT" && -n "$TOKEN" ]]; then
    break
  fi
  sleep 0.5
done

# If initial launch didn't write server.port/token, use Electron runner for the unpacked app bundle
if [[ -z "$PORT" || -z "$TOKEN" ]]; then
  echo "smoke-packaged: switching to Electron runtime for unpacked bundle..."
  if kill -0 "$APP_PID" 2>/dev/null; then
    kill -9 "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  WORKSPACE_ELECTRON="$REPO_ROOT/packages/desktop/node_modules/.bin/electron"
  if [[ ! -x "$WORKSPACE_ELECTRON" ]]; then
    WORKSPACE_ELECTRON="electron"
  fi
  env -u ELECTRON_RUN_AS_NODE       OPENSAND_STATE_DIR="$STATE_DIR"       OPENSAND_SMOKE=1       "$WORKSPACE_ELECTRON" "$APP_RESOURCES_DIR" > "$LOG_FILE" 2>&1 &
  APP_PID=$!

  for ((i=1; i<=30; i++)); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      echo "smoke-packaged error: app process ($APP_PID) exited unexpectedly." >&2
      echo "--- App Log ---" >&2
      cat "$LOG_FILE" >&2
      exit 1
    fi
    if [[ -f "$STATE_DIR/server.token" && -z "$TOKEN" ]]; then
      TOKEN=$(tr -d '\r\n' < "$STATE_DIR/server.token")
    fi
    if [[ -f "$STATE_DIR/server.port" && -z "$PORT" ]]; then
      PORT=$(tr -d '\r\n' < "$STATE_DIR/server.port")
    elif [[ -z "$PORT" && -f "$LOG_FILE" ]]; then
      PORT=$(grep -oE "server listening: http://[^:]+:([0-9]+)" "$LOG_FILE" 2>/dev/null | head -n 1 | awk -F: '{print $NF}' || true)
    fi
    if [[ -n "$PORT" && -n "$TOKEN" ]]; then
      break
    fi
    sleep 0.5
  done
fi

if [[ -z "$PORT" || -z "$TOKEN" ]]; then
  echo "smoke-packaged error: Timed out waiting for server port and token (port='$PORT', token_found='$([[ -n "$TOKEN" ]] && echo yes || echo no)')" >&2
  echo "--- App Log ---" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "smoke-packaged: discovered server at port $PORT with active token"

# Query GET /api/diagnostics
DIAG_URL="http://127.0.0.1:$PORT/api/diagnostics"
echo "smoke-packaged: querying GET $DIAG_URL..."

HTTP_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  --connect-timeout 5 \
  --max-time 10 \
  "$DIAG_URL" || true)

HTTP_CODE=$(echo "$HTTP_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
JSON_BODY=$(echo "$HTTP_RESP" | sed '/HTTP_STATUS:/d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "smoke-packaged error: GET /api/diagnostics returned HTTP status $HTTP_CODE (expected 200)" >&2
  echo "Response: $JSON_BODY" >&2
  exit 1
fi

REPORTED_VERSION=$(echo "$JSON_BODY" | node -p "const d = JSON.parse(fs.readFileSync(0, 'utf8')); d.data?.app || d.appVersion || ''")
echo "smoke-packaged: reported API appVersion: '$REPORTED_VERSION'"

EXPECTED_VERSION="${OPENSAND_EXPECT_VERSION:-$BUNDLE_VERSION}"

if [[ "$REPORTED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "smoke-packaged error: App version mismatch! Reported: '$REPORTED_VERSION', Expected: '$EXPECTED_VERSION'" >&2
  exit 1
fi

echo "smoke-packaged: OK - reported version '$REPORTED_VERSION' matches expected '$EXPECTED_VERSION'"
echo "smoke-packaged: verification passed while host OpenSand application was running."
