set -euo pipefail

# Hermetic selftest for scripts/install-health-check.sh
# Uses a stub "installed app" in a throwaway dir: it publishes a local port/token and
# answers GET /api/diagnostics. No real OpenSand.app or ~/.opensand is ever launched.
# Cases:
#   1. Happy path: app answers with the expected version -> 0
#   2. Wrong version reported -> 1
#   3. No answer (port/token published, nothing listening) -> 1
#   4. App exits before answering -> 1
#   5. Missing bundle path -> 1
#
# Mutation proof (from the repo root, after the files are tracked):
#   LINE=$(grep -n 'if \[\[ "\$REPORTED_VERSION" != "\$EXPECTED_VERSION" \]\]' scripts/install-health-check.sh | cut -d: -f1)
#   bash scripts/mutation-probe.sh scripts/install-health-check.sh "$LINE" \
#     'if [[ "$REPORTED_VERSION" == "$EXPECTED_VERSION" ]]; then' -- \
#     bash scripts/install-health-check-selftest.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_SCRIPT="${OPENSAND_HEALTH_CHECK_SCRIPT:-$ROOT/scripts/install-health-check.sh}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-health-selftest.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

make_stub_app() {
  local app="$1"
  local resources="$app/Contents/Resources"
  local exec="$app/Contents/MacOS/OpenSand"
  mkdir -p "$resources" "$(dirname "$exec")"

  # No shebang: macOS execvp falls back to /bin/sh, avoiding the AUTH_EXEC stall that
  # a generated shebang script under a temp dir can trigger.
  cat > "$exec" <<STUB
exec python3 "$resources/stub_server.py"
STUB
  chmod +x "$exec"

  cat > "$resources/stub_server.py" <<'PY'
import http.server, json, os, socket, sys, time
state = os.environ.get("OPENSAND_STATE_DIR", "")
mode = os.environ.get("STUB_MODE", "answer")
version = os.environ.get("STUB_APP_VERSION", "0.1.11")
if mode == "exit-early":
    sys.exit(1)
s = socket.socket()
s.bind(("127.0.0.1", 0))
port = s.getsockname()[1]
s.close()
with open(os.path.join(state, "server.port"), "w") as f:
    f.write(str(port))
with open(os.path.join(state, "server.token"), "w") as f:
    f.write("stub-token")
if mode == "no-answer":
    time.sleep(3600)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/diagnostics":
            body = json.dumps({"data": {"app": version}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
}

FAILED=0

run_case() {
  local label="$1"
  local expected_exit="$2"
  local app="$3"
  local stub_version="$4"
  local expected_version="$5"
  local mode="$6"

  local out status=0
  out=$(
    OPENSAND_HEALTH_TIMEOUT_SECONDS=3 \
    STUB_APP_VERSION="$stub_version" \
    STUB_MODE="$mode" \
    bash "$HEALTH_SCRIPT" "$app" "$expected_version" 2>&1
  ) || status=$?

  if [[ "$status" -ne "$expected_exit" ]]; then
    echo "FAIL $label: exit $status, wanted $expected_exit"
    printf '%s\n' "$out" | sed 's/^/    | /'
    FAILED=1
    return
  fi
  echo "PASS $label (exit $status)"
}

# --- Case 1: happy path ---
app="$WORK/case1/Applications/OpenSand.app"
make_stub_app "$app"
run_case "case1-happy" 0 "$app" "0.1.11" "0.1.11" "answer"

# --- Case 2: wrong version ---
app="$WORK/case2/Applications/OpenSand.app"
make_stub_app "$app"
run_case "case2-wrong-version" 1 "$app" "0.1.10" "0.1.11" "answer"

# --- Case 3: no answer ---
app="$WORK/case3/Applications/OpenSand.app"
make_stub_app "$app"
run_case "case3-no-answer" 1 "$app" "0.1.11" "0.1.11" "no-answer"

# --- Case 4: app exits before answering ---
app="$WORK/case4/Applications/OpenSand.app"
make_stub_app "$app"
run_case "case4-exit-early" 1 "$app" "0.1.11" "0.1.11" "exit-early"

# --- Case 5: missing bundle ---
run_case "case5-missing-bundle" 1 "$WORK/no-such-app/Applications/OpenSand.app" "0.1.11" "0.1.11" "answer"

if [[ "$FAILED" -eq 0 ]]; then
  echo "ALL INSTALL-HEALTH-CHECK SELFTESTS PASSED."
fi
exit "$FAILED"
