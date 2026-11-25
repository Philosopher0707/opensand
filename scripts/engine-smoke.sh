#!/usr/bin/env bash
# Packaged App Engine Smoke Test
# Usage:
#   scripts/engine-smoke.sh [path/to/OpenSand.zip | path/to/OpenSand.app]
#
# Unpacks/locates a built macOS application bundle, launches it in isolated smoke mode,
# connects to DevTools / CDP, and verifies that outside engines (opensand, claude, opencode,
# codex, copilot, antigravity, workbuddy) are listed in Settings (#settingEngine).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET_PATH="${1:-}"

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      echo "Usage: scripts/engine-smoke.sh [path/to/OpenSand.zip | path/to/OpenSand.app]"
      exit 0
      ;;
    *)
      if [[ -z "$TARGET_PATH" || "$TARGET_PATH" == --* ]]; then
        TARGET_PATH="$arg"
      fi
      ;;
  esac
done

if [[ -z "$TARGET_PATH" || "$TARGET_PATH" == --* ]]; then
  # Auto-detect built bundle or zip
  if [[ -d "$REPO_ROOT/dist/release/mac-arm64/OpenSand.app" ]]; then
    TARGET_PATH="$REPO_ROOT/dist/release/mac-arm64/OpenSand.app"
  elif [[ -d "$REPO_ROOT/dist/release/mac/OpenSand.app" ]]; then
    TARGET_PATH="$REPO_ROOT/dist/release/mac/OpenSand.app"
  else
    DEFAULT_ARCHIVE_DIR="$HOME/dev/_archive"
    if [[ -d "$DEFAULT_ARCHIVE_DIR" ]]; then
      TARGET_PATH=$(find "$DEFAULT_ARCHIVE_DIR" -name "*.zip" -type f -exec stat -f "%m %N" {} + 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2- || true)
    fi
  fi
fi

if [[ -z "$TARGET_PATH" || (! -f "$TARGET_PATH" && ! -d "$TARGET_PATH") ]]; then
  echo "engine-smoke error: No OpenSand.app bundle or .zip found. Provide path as first argument." >&2
  exit 1
fi

echo "engine-smoke: testing target: $TARGET_PATH"

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-engine-smoke.XXXXXX")
STATE_DIR="$TEMP_DIR/state"
USER_DATA_DIR="$TEMP_DIR/user-data"
WORKSPACE_DIR="$TEMP_DIR/workspace"
LOG_FILE="$TEMP_DIR/app.log"
UNPACK_DIR="$TEMP_DIR/unpacked"

mkdir -p "$STATE_DIR" "$USER_DATA_DIR" "$WORKSPACE_DIR"

APP_PID=""

# Hash helper to guard host directories by content hash, not mtime
dir_content_hash() {
  python3 - "$1" << 'HASH_PY' 2>/dev/null || echo "error"
import os, sys, hashlib
path = sys.argv[1]
if not os.path.exists(path):
    print("absent")
    sys.exit(0)
h = hashlib.sha256()
for root, dirs, files in os.walk(path):
    dirs.sort()
    for f in sorted(files):
        p = os.path.join(root, f)
        rel = os.path.relpath(p, path)
        h.update(rel.encode("utf-8"))
        try:
            with open(p, "rb") as fp:
                while chunk := fp.read(65536):
                    h.update(chunk)
        except Exception:
            pass
print(h.hexdigest())
HASH_PY
}

# Baseline content hash check for host state and app support
HOST_STATE_DIR="${OPENSAND_HOST_STATE_DIR:-$HOME/.opensand}"
HOST_APP_SUPPORT_DIR="${OPENSAND_HOST_APP_SUPPORT_DIR:-$HOME/Library/Application Support/OpenSand}"
BEFORE_STATE_HASH=$(dir_content_hash "$HOST_STATE_DIR")
BEFORE_APP_SUPPORT_HASH=$(dir_content_hash "$HOST_APP_SUPPORT_DIR")

# Redaction helper for app logs before printing
redact_app_log() {
  local log_file="$1"
  if [[ ! -f "$log_file" ]]; then return; fi
  python3 - "$log_file" << 'REDACT_PY'
import sys, re
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    lines = lines[-100:]
    content = "".join(lines)
    content = re.sub(r"sk-[A-Za-z0-9_-]{10,}", "[REDACTED_API_KEY]", content)
    content = re.sub(r"gh[pousr]_[A-Za-z0-9]{15,}", "[REDACTED_TOKEN]", content)
    content = re.sub(r"AKIA[0-9A-Z]{16}", "[REDACTED_AWS_KEY]", content)
    content = re.sub(r"(Bearer\s+)[A-Za-z0-9_.\-]+", r"\1[REDACTED]", content, flags=re.IGNORECASE)
    content = re.sub(r"""(["']?[A-Za-z0-9_-]*(?:api_?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}\]]+""", r"\1[REDACTED]", content, flags=re.IGNORECASE)
    sys.stdout.write(content)
except Exception as e:
    sys.stderr.write(f"Error reading log: {e}\n")
REDACT_PY
}
print_redacted_app_log() {
  echo "--- App Log (redacted summary) ---" >&2
  redact_app_log "$LOG_FILE" >&2
}

cleanup() {
  local exit_code=$?
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "engine-smoke: terminating app (pid $APP_PID)..."
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

  AFTER_STATE_HASH=$(dir_content_hash "$HOST_STATE_DIR")
  AFTER_APP_SUPPORT_HASH=$(dir_content_hash "$HOST_APP_SUPPORT_DIR")

  if [[ "$BEFORE_STATE_HASH" != "$AFTER_STATE_HASH" ]]; then
    echo "engine-smoke error: $HOST_STATE_DIR content changed during engine smoke test (state isolation broken)!" >&2
    exit_code=1
  fi
  if [[ "$BEFORE_APP_SUPPORT_HASH" != "$AFTER_APP_SUPPORT_HASH" ]]; then
    echo "engine-smoke error: $HOST_APP_SUPPORT_DIR content changed during engine smoke test (app support isolation broken)!" >&2
    exit_code=1
  fi

  if [[ "${KEEP_SMOKE_TEMP:-0}" != "1" ]]; then
    rm -rf "$TEMP_DIR" 2>/dev/null || true
  else
    echo "engine-smoke: kept temp directory: $TEMP_DIR"
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

APP_DIR=""
if [[ -d "$TARGET_PATH" && "$TARGET_PATH" == *.app ]]; then
  APP_DIR="$TARGET_PATH"
elif [[ -f "$TARGET_PATH" && "$TARGET_PATH" == *.zip ]]; then
  echo "engine-smoke: unpacking $TARGET_PATH..."
  mkdir -p "$UNPACK_DIR"
  unzip -q "$TARGET_PATH" -d "$UNPACK_DIR"
  APP_DIR=$(find "$UNPACK_DIR" -maxdepth 2 -name "*.app" -type d | head -n 1)
fi

if [[ -z "$APP_DIR" || ! -d "$APP_DIR" ]]; then
  echo "engine-smoke error: Could not find .app bundle from $TARGET_PATH" >&2
  exit 1
fi

APP_RESOURCES_DIR="$APP_DIR/Contents/Resources/app"
EXEC_PATH="$APP_DIR/Contents/MacOS/OpenSand"
if [[ ! -x "$EXEC_PATH" ]]; then
  echo "engine-smoke error: App executable not found or not executable at $EXEC_PATH" >&2
  exit 1
fi

# Pre-launch bundle isolation check: reject legacy bundles lacking OPENSAND_STATE_DIR support
UNPACKED_MAIN_JS="$APP_RESOURCES_DIR/dist/src/main.js"
if [[ -f "$UNPACKED_MAIN_JS" ]] && ! grep -q "OPENSAND_STATE_DIR" "$UNPACKED_MAIN_JS"; then
  echo "engine-smoke: UNVERIFIED: bundle predates isolated state support (missing OPENSAND_STATE_DIR in dist/src/main.js)" >&2
  exit 2
fi

# Pre-trust workspace in folder-trust.json
CANONICAL_WORKSPACE=$(node -e 'console.log(require("fs").realpathSync.native(process.argv[1]))' "$WORKSPACE_DIR")
cat << JSON > "$STATE_DIR/folder-trust.json"
{
  "version": 1,
  "folders": {
    "$CANONICAL_WORKSPACE": { "level": "trusted" }
  }
}
JSON

# Set minimal local endpoint to satisfy first-run onboarding
cat << JSON > "$STATE_DIR/config.json"
{
  "endpoint": "http://127.0.0.1:1234/v1/chat/completions",
  "model": "local",
  "approvalMode": "auto",
  "autoApprove": true,
  "engine": "opensand",
  "workspaceDir": "$CANONICAL_WORKSPACE"
}
JSON

CDP_PORT=9242

echo "engine-smoke: launching app with CDP port $CDP_PORT..."

# Scrub credential variables from child environment
UNSET_ARGS=()
for env_var in $(env | awk -F= '{print $1}'); do
  case "$env_var" in
    *_API_KEY|*_TOKEN|*_SECRET|*_AUTH|OPENAI_*|ANTHROPIC_*|GEMINI_*|AWS_*)
      UNSET_ARGS+=("-u" "$env_var")
      ;;
  esac
done

(
  cd "$CANONICAL_WORKSPACE"
  env -u ELECTRON_RUN_AS_NODE "${UNSET_ARGS[@]}" \
    OPENSAND_STATE_DIR="$STATE_DIR" \
    OPENSAND_SMOKE=1 \
    OPENSAND_HIDDEN_WINDOW=1 \
    "$EXEC_PATH" \
    --remote-debugging-port=$CDP_PORT \
    --user-data-dir="$USER_DATA_DIR" > "$LOG_FILE" 2>&1
) &
APP_PID=$!

echo "engine-smoke: app running with PID $APP_PID"

# Wait for CDP endpoint to be available
READY=0
for ((i=1; i<=30; i++)); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "engine-smoke error: app process exited prematurely." >&2
    print_redacted_app_log
    exit 1
  fi
  if curl -s "http://127.0.0.1:$CDP_PORT/json" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "$READY" -ne 1 ]]; then
  echo "engine-smoke error: CDP port $CDP_PORT did not become ready." >&2
  print_redacted_app_log
  exit 1
fi

echo "engine-smoke: DevTools CDP available. Running engine verification..."

# Run headless verification via Node
node - << NODE_SCRIPT
const fs = require('fs');
const { EventEmitter } = require('events');

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
  }
  async connect() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = reject;
      this.ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.id && this.callbacks.has(data.id)) {
          const cb = this.callbacks.get(data.id);
          this.callbacks.delete(data.id);
          if (data.error) cb.reject(new Error(data.error.message));
          else cb.resolve(data.result);
        }
      };
    });
  }
  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || "Evaluation error");
    }
    return res.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function run() {
  const cdpRes = await fetch("http://127.0.0.1:$CDP_PORT/json");
  const list = await cdpRes.json();
  const page = list.find((p) => p.type === "page");
  if (!page) throw new Error("No page found in CDP targets");

  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Wait for settings button
  for (let i = 0; i < 30; i++) {
    const ready = await cdp.evaluate("Boolean(document.querySelector('#btnSettings'))");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Open settings
  await cdp.evaluate("(() => { if (typeof openSettings === 'function') openSettings(); else document.querySelector('#btnSettings')?.click(); })()");
  await new Promise((r) => setTimeout(r, 1000));

  // Inspect #settingEngine
  const engines = await cdp.evaluate(`(() => {
    const sel = document.querySelector('#settingEngine');
    if (!sel) return [];
    return Array.from(sel.options).map(o => ({
      value: o.value,
      label: o.dataset.label || o.textContent.trim(),
      disabled: o.disabled,
    }));
  })()`);

  console.log("engine-smoke: discovered engine options in Settings:");
  console.table(engines);

  const expected = ["opensand", "claude", "opencode", "codex", "copilot", "antigravity", "workbuddy"];
  const missing = expected.filter(exp => !engines.some(e => e.value === exp));
  if (missing.length > 0) {
    throw new Error("Missing expected engine options in Settings: " + missing.join(", "));
  }

  console.log("PASS: All 7 engines present in Settings selector (#settingEngine).");
  cdp.close();
}

run().catch((err) => {
  console.error("engine-smoke test failure:", err.message);
  process.exit(1);
});
NODE_SCRIPT

echo "engine-smoke: PASS - packaged app engine smoke check passed cleanly."
exit 0
