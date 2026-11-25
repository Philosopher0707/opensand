#!/usr/bin/env bash
# Hermetic selftest for scripts/release.sh post-install restart and API probe
# Covers hotfix-path row (a) on PR #264:
#   1. Red: Stale-version stub makes release.sh --install fail red
#   2. Green: Matching-version stub makes release.sh --install pass green
#   3. Red: Empty engines list from GET /api/engines/detect makes release.sh fail red
#   4. Red: Connection refused / no server makes release.sh fail red
#   5. Graceful quit: osascript quit command is called when OpenSand is running
#   6. Probe bearer token never appears in curl argv, and --noproxy is used with proxy env set
#   7. A spoofed process with "OpenSand.app" in its arguments is not signalled
#
# No real installation or ~/.opensand state is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_SCRIPT="${OPENSAND_RELEASE_SCRIPT:-$ROOT/scripts/release.sh}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-restart-selftest.XXXXXX")
BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR"

cleanup() {
  # Terminate any remaining background stub servers
  if [[ -f "$WORK/pids.txt" ]]; then
    while IFS= read -r pid; do
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done < "$WORK/pids.txt"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# Hermetic df mock (reports 50 GB free so disk guard passes instantly)
cat << 'EOS' > "$BIN_DIR/df"
#!/usr/bin/env bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/disk99 100000000 10000000 90000000 10% /System/Volumes/Data"
EOS
chmod +x "$BIN_DIR/df"

# Hermetic gh mock
cat << 'EOS' > "$BIN_DIR/gh"
#!/usr/bin/env bash
case "$1" in
  pr)
    case "$2" in
      list) echo '[{"number": 42, "state": "MERGED"}]'; exit 0 ;;
      view) echo '{"state":"MERGED"}'; exit 0 ;;
    esac
    ;;
  release)
    case "$2" in
      download)
        dest=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "-D" ] || [ "$1" = "--dir" ]; then dest="$2"; shift 2; else shift; fi
        done
        mkdir -p "$dest"
        echo "mock zip" > "$dest/OpenSand-0.1.18-arm64-mac.zip"
        echo "mock dmg" > "$dest/OpenSand-0.1.18-arm64.dmg"
        exit 0
        ;;
    esac
    ;;
esac
exit 0
EOS
chmod +x "$BIN_DIR/gh"

# Hermetic hdiutil mock
cat << 'EOS' > "$BIN_DIR/hdiutil"
#!/usr/bin/env bash
case "$1" in
  attach)
    mountpoint=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-mountpoint" ]; then mountpoint="$2"; shift 2; else shift; fi
    done
    if [ -n "$mountpoint" ] && [ -d "$TEST_CASE_DIR/mock_dmg_app" ]; then
      mkdir -p "$mountpoint"
      cp -R "$TEST_CASE_DIR/mock_dmg_app/"* "$mountpoint/" 2>/dev/null || true
    fi
    exit 0
    ;;
  detach) exit 0 ;;
esac
exit 0
EOS
chmod +x "$BIN_DIR/hdiutil"

# Hermetic git mock wrapper
cat << 'EOS' > "$BIN_DIR/git"
#!/usr/bin/env bash
case "$1" in
  ls-remote)
    for arg in "$@"; do
      if [ "$arg" = "--tags" ]; then
        printf "abcdef1234567890\trefs/tags/v0.1.18\n"
        exit 0
      fi
    done
    /usr/bin/git "$@"
    ;;
  rev-parse)
    if [[ "$*" == *"refs/tags/"* || "$*" == *"v0.1."* ]]; then
      echo "abcdef1234567890"
      exit 0
    fi
    echo "1111111111111111111111111111111111111111"
    exit 0
    ;;
  show)
    case "${2:-}" in
      *:packages/desktop/package.json)
        node -p "JSON.stringify({version: '0.1.18'})"
        exit 0
        ;;
    esac
    /usr/bin/git "$@"
    ;;
  tag|push|fetch|checkout|add|commit)
    exit 0
    ;;
  *)
    /usr/bin/git "$@"
    ;;
esac
EOS
chmod +x "$BIN_DIR/git"

# Hermetic open mock (records open -a calls)
cat << 'EOS' > "$BIN_DIR/open"
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_CASE_DIR/open_calls.log"
exit 0
EOS
chmod +x "$BIN_DIR/open"

# Hermetic osascript mock (records quit calls)
cat << 'EOS' > "$BIN_DIR/osascript"
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_CASE_DIR/osascript_calls.log"
exit 0
EOS
chmod +x "$BIN_DIR/osascript"

# Hermetic mock pr-gate
cat << 'EOS' > "$WORK/mock-pr-gate.sh"
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$WORK/mock-pr-gate.sh"

# Hermetic mock smoke scripts
cat << 'EOS' > "$WORK/mock-smoke.sh"
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$WORK/mock-smoke.sh"

cat << 'EOS' > "$WORK/mock-smoke-linux.sh"
#!/usr/bin/env bash
exit 0
EOS
chmod +x "$WORK/mock-smoke-linux.sh"

# Hermetic mock health check
cat << 'EOS' > "$WORK/mock-health.sh"
#!/usr/bin/env bash
printf '%s %s\n' "$1" "$2" >> "$TEST_CASE_DIR/health_check_args.log"
exit 0
EOS
chmod +x "$WORK/mock-health.sh"

create_mock_app() {
  local target_dir="$1"
  local ver="$2"
  mkdir -p "$target_dir/Contents/MacOS"
  cat << PLIST > "$target_dir/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleShortVersionString</key>
    <string>$ver</string>
</dict>
</plist>
PLIST
  echo "# mock binary" > "$target_dir/Contents/MacOS/OpenSand"
  chmod +x "$target_dir/Contents/MacOS/OpenSand"
}

# Starts a stub HTTP server that simulates OpenSand desktop server
start_stub_server() {
  local case_dir="$1"
  local reported_ver="$2"
  local engines_mode="$3" # "normal" or "empty"

  local state_dir="$case_dir/state"
  mkdir -p "$state_dir"

  # Pick an ephemeral port via python and run server
  local ready_file="$case_dir/server_ready"
  rm -f "$ready_file"

  python3 -c "
import http.server, json, sys

reported_ver = '$reported_ver'
engines_mode = '$engines_mode'

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization', '')
        # Verify token is provided
        if not auth.startswith('Bearer stub-token-secret-12345'):
            self.send_response(401)
            self.end_headers()
            return

        if self.path == '/api/version':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'app': reported_ver, 'electron': '45.2.3'}).encode())
        elif self.path == '/api/engines/detect':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            if engines_mode == 'empty':
                self.wfile.write(b'[]')
            else:
                self.wfile.write(json.dumps([{'engine': 'claude', 'installed': True}]).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
port = server.server_port

with open('$state_dir/server.port', 'w') as f:
    f.write(str(port) + '\n')
with open('$state_dir/server.token', 'w') as f:
    f.write('stub-token-secret-12345\n')

with open('$ready_file', 'w') as f:
    f.write(str(port))

server.serve_forever()
" &
  local server_pid=$!
  echo "$server_pid" >> "$WORK/pids.txt"

  # Wait for server ready
  local deadline=$(( $(date +%s) + 5 ))
  while (( $(date +%s) < deadline )); do
    if [[ -f "$ready_file" ]]; then break; fi
    sleep 0.1
  done

  if [[ ! -f "$ready_file" ]]; then
    echo "FAIL: stub server failed to start within 5s" >&2
    exit 1
  fi
}

FAILED=0

run_install_test() {
  local label="$1"
  local expected_exit="$2"
  local ver="$3"
  local reported_ver="$4"
  local engines_mode="$5"
  local start_server="$6" # 1 or 0

  local dir="$WORK/$label"
  mkdir -p "$dir/download" "$dir/Applications" "$dir/state" "$dir/archive" "$dir/pack"
  echo "{\"version\":\"$ver\"}" > "$dir/default_desktop_pkg.json"

  create_mock_app "$dir/Applications/OpenSand.app" "0.1.10"
  create_mock_app "$dir/pack/OpenSand.app" "$ver"
  (cd "$dir/pack" && zip -q -r "$dir/download/OpenSand-$ver-arm64-mac.zip" OpenSand.app)
  echo "mock dmg" > "$dir/download/OpenSand-$ver-arm64.dmg"
  create_mock_app "$dir/mock_dmg_app/OpenSand.app" "$ver"

  if [[ "$start_server" -eq 1 ]]; then
    start_stub_server "$dir" "$reported_ver" "$engines_mode"
  fi

  local out status=0
  out=$(
    PATH="$BIN_DIR:$PATH" \
    TEST_CASE_DIR="$dir" \
    OPENSAND_PR_GATE_SCRIPT="$WORK/mock-pr-gate.sh" \
    OPENSAND_SMOKE_SCRIPT="$WORK/mock-smoke.sh" \
    OPENSAND_LINUX_SMOKE_SCRIPT="$WORK/mock-smoke-linux.sh" \
    OPENSAND_HEALTH_CHECK_SCRIPT="$WORK/mock-health.sh" \
    OPENSAND_DESKTOP_PKG="$dir/default_desktop_pkg.json" \
    OPENSAND_INSTALL_APP_DEST="$dir/Applications/OpenSand.app" \
    OPENSAND_ARCHIVE_DIR_BASE="$dir/archive" \
    OPENSAND_STATE_DIR="$dir/state" \
    OPENSAND_RESTART_PROBE_TIMEOUT_SECONDS=2 \
    RELEASE_DOWNLOAD_DIR="$dir/download" \
    bash "$RELEASE_SCRIPT" --install "$ver" 2>&1
  ) || status=$?

  printf '%s\n' "$out" > "$dir/run.out"

  if [[ "$status" -ne "$expected_exit" ]]; then
    echo "FAIL $label: exit $status, wanted $expected_exit" >&2
    echo "$out" | sed 's/^/    | /' >&2
    FAILED=1
    return 1
  fi

  echo "PASS $label (exit $status)"
  return 0
}

echo "Running release-install-restart selftests..."

# --- Case 1: Stale-version stub (FAIL RED) ---
echo "--- [Case 1: Red test] Stale-version stub must fail red ---"
case1_dir="$WORK/case1-stale-version"
run_install_test "case1-stale-version" 1 "0.1.18" "0.1.17" "normal" 1 || true
if grep -q "reported stale version '0.1.17', expected '0.1.18'" "$case1_dir/run.out"; then
  echo "PASS case1: red test confirmed - stale version 0.1.17 rejected against target 0.1.18"
else
  echo "FAIL case1: expected stale version error message not found in output" >&2
  cat "$case1_dir/run.out" >&2
  FAILED=1
fi

# --- Case 2: Matching-version stub (PASS GREEN) ---
echo "--- [Case 2: Green test] Matching-version stub must pass green ---"
case2_dir="$WORK/case2-matching-version"
run_install_test "case2-matching-version" 0 "0.1.18" "0.1.18" "normal" 1
if grep -q "PASS: Running OpenSand process verified: /api/version matches v0.1.18 and /api/engines/detect returned active engines" "$case2_dir/run.out"; then
  echo "PASS case2: green test confirmed - matching version 0.1.18 and active engines accepted"
else
  echo "FAIL case2: expected success message not found in output" >&2
  cat "$case2_dir/run.out" >&2
  FAILED=1
fi
if [[ -f "$case2_dir/open_calls.log" ]] && grep -q -- "-a $case2_dir/Applications/OpenSand.app" "$case2_dir/open_calls.log"; then
  echo "PASS case2: open -a called to relaunch the installed app"
else
  echo "FAIL case2: open -a was not called with the installed app" >&2
  FAILED=1
fi

# --- Case 3: Empty engines list (FAIL RED) ---
echo "--- [Case 3: Red test] Empty engines list must fail red ---"
case3_dir="$WORK/case3-empty-engines"
run_install_test "case3-empty-engines" 1 "0.1.18" "0.1.18" "empty" 1 || true
if grep -q "engines list was empty" "$case3_dir/run.out"; then
  echo "PASS case3: red test confirmed - empty engines list rejected"
else
  echo "FAIL case3: expected empty engines error message not found in output" >&2
  cat "$case3_dir/run.out" >&2
  FAILED=1
fi

# --- Case 4: No answer / connection refused (FAIL RED) ---
echo "--- [Case 4: Red test] Connection refused / no server must fail red ---"
case4_dir="$WORK/case4-no-server"
run_install_test "case4-no-server" 1 "0.1.18" "0.1.18" "normal" 0 || true
if grep -q "restart probe failed after" "$case4_dir/run.out"; then
  echo "PASS case4: red test confirmed - unresponsive server timed out and failed"
else
  echo "FAIL case4: expected restart probe timeout not found in output" >&2
  cat "$case4_dir/run.out" >&2
  FAILED=1
fi

# --- Case 5: Graceful quit issued to running app ---
echo "--- [Case 5] Graceful quit issued to running OpenSand app ---"
case5_dir="$WORK/case5-graceful-quit"
mkdir -p "$case5_dir/download" "$case5_dir/Applications" "$case5_dir/state" "$case5_dir/archive" "$case5_dir/pack"
echo '{"version":"0.1.18"}' > "$case5_dir/default_desktop_pkg.json"
create_mock_app "$case5_dir/Applications/OpenSand.app" "0.1.10"
create_mock_app "$case5_dir/pack/OpenSand.app" "0.1.18"
(cd "$case5_dir/pack" && zip -q -r "$case5_dir/download/OpenSand-0.1.18-arm64-mac.zip" OpenSand.app)
echo "mock dmg" > "$case5_dir/download/OpenSand-0.1.18-arm64.dmg"
create_mock_app "$case5_dir/mock_dmg_app/OpenSand.app" "0.1.18"
start_stub_server "$case5_dir" "0.1.18" "normal"

# Start a mock running OpenSand process
sleep 30 &
MOCK_APP_PID=$!
echo "$MOCK_APP_PID" >> "$WORK/pids.txt"

# Stub pgrep to return this PID when queried for OpenSand.app
cat << EOS > "$BIN_DIR/pgrep"
#!/usr/bin/env bash
for arg in "\$@"; do
  if [[ "\$arg" == *"OpenSand"* ]]; then
    echo "$MOCK_APP_PID"
    exit 0
  fi
done
/usr/bin/pgrep "\$@"
EOS
chmod +x "$BIN_DIR/pgrep"

# ps stub: report the exact app binary for the mock PID, as the real app would
cat << EOS > "$BIN_DIR/ps"
#!/usr/bin/env bash
if [[ "\$*" == *"-p $MOCK_APP_PID"* ]]; then
  echo "$case5_dir/Applications/OpenSand.app/Contents/MacOS/OpenSand"
  exit 0
fi
/bin/ps "\$@"
EOS
chmod +x "$BIN_DIR/ps"

out5=$(
  PATH="$BIN_DIR:$PATH" \
  TEST_CASE_DIR="$case5_dir" \
  OPENSAND_PR_GATE_SCRIPT="$WORK/mock-pr-gate.sh" \
  OPENSAND_SMOKE_SCRIPT="$WORK/mock-smoke.sh" \
  OPENSAND_LINUX_SMOKE_SCRIPT="$WORK/mock-smoke-linux.sh" \
  OPENSAND_HEALTH_CHECK_SCRIPT="$WORK/mock-health.sh" \
  OPENSAND_DESKTOP_PKG="$case5_dir/default_desktop_pkg.json" \
  OPENSAND_INSTALL_APP_DEST="$case5_dir/Applications/OpenSand.app" \
  OPENSAND_ARCHIVE_DIR_BASE="$case5_dir/archive" \
  OPENSAND_STATE_DIR="$case5_dir/state" \
  OPENSAND_QUIT_TIMEOUT_SECONDS=1 \
  OPENSAND_RESTART_PROBE_TIMEOUT_SECONDS=2 \
  RELEASE_DOWNLOAD_DIR="$case5_dir/download" \
  bash "$RELEASE_SCRIPT" --install "0.1.18" 2>&1
) || true
kill -9 "$MOCK_APP_PID" 2>/dev/null || true
rm -f "$BIN_DIR/pgrep" "$BIN_DIR/ps"

if [[ -f "$case5_dir/osascript_calls.log" ]] && grep -q 'tell application "OpenSand" to quit' "$case5_dir/osascript_calls.log"; then
  echo "PASS case5: osascript graceful quit called on running instance"
else
  echo "FAIL case5: osascript graceful quit was not called" >&2
  FAILED=1
fi

# --- Case 6: bearer token never in curl argv; --noproxy with proxy env set ---
echo "--- [Case 6] Probe token absent from curl argv and --noproxy used with proxy env set ---"
prepare_install_case() {
  local dir="$1"
  mkdir -p "$dir/download" "$dir/Applications" "$dir/state" "$dir/archive" "$dir/pack"
  echo '{"version":"0.1.18"}' > "$dir/default_desktop_pkg.json"
  create_mock_app "$dir/Applications/OpenSand.app" "0.1.10"
  create_mock_app "$dir/pack/OpenSand.app" "0.1.18"
  (cd "$dir/pack" && zip -q -r "$dir/download/OpenSand-0.1.18-arm64-mac.zip" OpenSand.app)
  echo "mock dmg" > "$dir/download/OpenSand-0.1.18-arm64.dmg"
  create_mock_app "$dir/mock_dmg_app/OpenSand.app" "0.1.18"
}

run_case_install() {
  local dir="$1"; shift
  (
    env "$@" \
      PATH="$BIN_DIR:$PATH" \
      TEST_CASE_DIR="$dir" \
      OPENSAND_PR_GATE_SCRIPT="$WORK/mock-pr-gate.sh" \
      OPENSAND_SMOKE_SCRIPT="$WORK/mock-smoke.sh" \
      OPENSAND_LINUX_SMOKE_SCRIPT="$WORK/mock-smoke-linux.sh" \
      OPENSAND_HEALTH_CHECK_SCRIPT="$WORK/mock-health.sh" \
      OPENSAND_DESKTOP_PKG="$dir/default_desktop_pkg.json" \
      OPENSAND_INSTALL_APP_DEST="$dir/Applications/OpenSand.app" \
      OPENSAND_ARCHIVE_DIR_BASE="$dir/archive" \
      OPENSAND_STATE_DIR="$dir/state" \
      OPENSAND_RESTART_PROBE_TIMEOUT_SECONDS=2 \
      RELEASE_DOWNLOAD_DIR="$dir/download" \
      bash "$RELEASE_SCRIPT" --install "0.1.18" 2>&1
  )
}

case6_dir="$WORK/case6-curl-argv"
prepare_install_case "$case6_dir"
start_stub_server "$case6_dir" "0.1.18" "normal"

cat << EOS > "$BIN_DIR/curl"
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$case6_dir/curl_argv.log"
exec /usr/bin/curl "\$@"
EOS
chmod +x "$BIN_DIR/curl"

status6=0
out6=$(run_case_install "$case6_dir" \
  http_proxy="http://127.0.0.1:1" https_proxy="http://127.0.0.1:1" \
  HTTPS_PROXY="http://127.0.0.1:1" ALL_PROXY="http://127.0.0.1:1" \
  no_proxy="" NO_PROXY="") || status6=$?
rm -f "$BIN_DIR/curl"
printf '%s\n' "$out6" > "$case6_dir/run.out"

if [[ "$status6" -eq 0 ]] && grep -q "PASS: Running OpenSand process verified" "$case6_dir/run.out"; then
  echo "PASS case6: probe succeeded through --noproxy with proxy env set"
else
  echo "FAIL case6: probe did not succeed with proxy env set (exit $status6)" >&2
  cat "$case6_dir/run.out" >&2
  FAILED=1
fi
if [[ -f "$case6_dir/curl_argv.log" ]] && ! grep -q "stub-token-secret-12345" "$case6_dir/curl_argv.log"; then
  echo "PASS case6: bearer token absent from curl argv"
else
  echo "FAIL case6: bearer token appeared in curl argv" >&2
  cat "$case6_dir/curl_argv.log" >&2
  FAILED=1
fi
if [[ -f "$case6_dir/curl_argv.log" ]] && grep -q -- "--noproxy" "$case6_dir/curl_argv.log"; then
  echo "PASS case6: --noproxy present on probe curl"
else
  echo "FAIL case6: --noproxy missing from probe curl argv" >&2
  cat "$case6_dir/curl_argv.log" >&2
  FAILED=1
fi

# --- Case 7: spoofed process with OpenSand.app in its arguments is not signalled ---
echo "--- [Case 7] Spoofed process with OpenSand.app in args is not signalled ---"
case7_dir="$WORK/case7-spoofed-process"
prepare_install_case "$case7_dir"
start_stub_server "$case7_dir" "0.1.18" "normal"

bash -c 'sleep 60; :' "/Applications/OpenSand.app/Contents/MacOS/OpenSand" &
SPOOF_PID=$!
echo "$SPOOF_PID" >> "$WORK/pids.txt"

status7=0
out7=$(run_case_install "$case7_dir" OPENSAND_QUIT_TIMEOUT_SECONDS=1) || status7=$?
printf '%s\n' "$out7" > "$case7_dir/run.out"

if kill -0 "$SPOOF_PID" 2>/dev/null; then
  echo "PASS case7: spoofed process with OpenSand.app in args was not signalled"
else
  echo "FAIL case7: spoofed process was signalled" >&2
  FAILED=1
fi
if grep -q "No running OpenSand process detected." "$case7_dir/run.out"; then
  echo "PASS case7: spoofed process not selected as the installed app"
else
  echo "FAIL case7: spoofed process was selected as the installed app" >&2
  cat "$case7_dir/run.out" >&2
  FAILED=1
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: release-install-restart selftests failed." >&2
  exit 1
fi

echo "ALL RELEASE-INSTALL-RESTART SELFTESTS PASSED."
exit 0
