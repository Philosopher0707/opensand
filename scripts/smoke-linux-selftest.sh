#!/usr/bin/env bash
# Hermetic selftest for scripts/smoke-linux.sh
# Uses fake dpkg-deb / xvfb-run / curl and a fixture "packaged app"; no real
# .deb, display, root or downloaded content is involved.
# OPENSAND_SMOKE_LINUX_SCRIPT points at the script under test (a mutant for a
# mutation proof).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_UNDER_TEST="${OPENSAND_SMOKE_LINUX_SCRIPT:-$ROOT/scripts/smoke-linux.sh}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-smoke-linux-selftest.XXXXXX")
BIN_DIR="$WORK/bin"
mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK"' EXIT

# Fake dpkg-deb: -x extracts a fixture tree; -f reports the deb version.
cat << 'EOS' > "$BIN_DIR/fake-dpkg-deb"
#!/usr/bin/env bash
case "$1" in
  -x)
    dest="$3"
    mkdir -p "$dest/opt/OpenSand" "$dest/usr/share/applications"
    cat << 'APP' > "$dest/opt/OpenSand/OpenSand"
#!/usr/bin/env bash
if [ -f "$TEST_CASE_DIR/app_early_exit" ]; then exit 3; fi
if [ ! -f "$TEST_CASE_DIR/app_no_port" ]; then
  printf '45123\n' > "$OPENSAND_STATE_DIR/server.port"
fi
printf 'token-SHOULD-NOT-LEAK-XYZ\n' > "$OPENSAND_STATE_DIR/server.token"
exec sleep 30
APP
    chmod +x "$dest/opt/OpenSand/OpenSand"
    printf '[Desktop Entry]\nName=OpenSand\nType=Application\nExec=/opt/OpenSand/OpenSand %%U\n' > "$dest/usr/share/applications/opensand.desktop"
    if [ -f "$TEST_CASE_DIR/macho" ]; then
      printf '\xcf\xfa\xed\xfe' > "$dest/opt/OpenSand/HiddenMachOHelper"
    fi
    echo "fake dpkg-deb -x" >> "$TEST_CASE_DIR/dpkg_calls.log"
    exit 0
    ;;
  -f)
    ver="0.1.11"
    [ -f "$TEST_CASE_DIR/deb_version" ] && ver=$(cat "$TEST_CASE_DIR/deb_version")
    printf '%s\n' "$ver"
    exit 0
    ;;
esac
exit 1
EOS
chmod +x "$BIN_DIR/fake-dpkg-deb"

# Fake xvfb-run: drop its -a flag and run the command directly.
cat << 'EOS' > "$BIN_DIR/fake-xvfb-run"
#!/usr/bin/env bash
[ "$1" = "-a" ] && shift
exec "$@"
EOS
chmod +x "$BIN_DIR/fake-xvfb-run"

# Fake curl: emit the diagnostics body plus the HTTP_STATUS marker.
cat << 'EOS' > "$BIN_DIR/fake-curl"
#!/usr/bin/env bash
ver="0.1.11"
[ -f "$TEST_CASE_DIR/diag_version" ] && ver=$(cat "$TEST_CASE_DIR/diag_version")
printf '{"data":{"app":"%s"}}\nHTTP_STATUS:200\n' "$ver"
exit 0
EOS
chmod +x "$BIN_DIR/fake-curl"

SAMPLE_DEB="$WORK/sample.deb"
echo "fixture deb" > "$SAMPLE_DEB"

FAILED=0
CASE_OUT_FILE=""

run_case() {
  local label="$1"; local expected="$2"; shift 2
  local dir="$WORK/$label"
  mkdir -p "$dir"
  CASE_OUT_FILE="$dir/run.out"
  local status=0
  TEST_CASE_DIR="$dir" \
    OPENSAND_DPKG_DEB="$BIN_DIR/fake-dpkg-deb" \
    OPENSAND_XVFB_RUN="$BIN_DIR/fake-xvfb-run" \
    OPENSAND_CURL="$BIN_DIR/fake-curl" \
    OPENSAND_SMOKE_STARTUP_TIMEOUT_SECONDS="${CASE_STARTUP_TIMEOUT:-5}" \
    bash "$SCRIPT_UNDER_TEST" "$@" > "$CASE_OUT_FILE" 2>&1 || status=$?
  if [ "$status" -ne "$expected" ]; then
    echo "FAIL $label: exit $status, wanted $expected"
    sed 's/^/    | /' "$CASE_OUT_FILE"
    FAILED=1
  else
    echo "PASS $label (exit $status)"
  fi
}

assert_out() {
  if ! grep -qF -- "$2" "$CASE_OUT_FILE"; then
    echo "FAIL $1: output is missing '$2'"
    sed 's/^/    | /' "$CASE_OUT_FILE"
    FAILED=1
  fi
}

refute_out() {
  if grep -qF -- "$2" "$CASE_OUT_FILE"; then
    echo "FAIL $1: output leaked '$2'"
    FAILED=1
  fi
}

# --- Case 1: success, exact output, no secret, real dpkg-deb path exercised ---
run_case "case1-success" 0 "$SAMPLE_DEB"
assert_out  "case1-success" "OpenSand 0.1.11 linux ok"
refute_out "case1-success" "SHOULD-NOT-LEAK-XYZ"
if [ ! -f "$WORK/case1-success/dpkg_calls.log" ]; then
  echo "FAIL case1-success: dpkg-deb -x was not called"
  FAILED=1
fi

# --- Case 2: wrong diagnostics version ---
mkdir -p "$WORK/case2-wrong-version"
echo "9.9.9" > "$WORK/case2-wrong-version/diag_version"
run_case "case2-wrong-version" 1 "$SAMPLE_DEB"
assert_out "case2-wrong-version" "version mismatch"

# --- Case 3: app exits before writing port ---
mkdir -p "$WORK/case3-early-exit"
touch "$WORK/case3-early-exit/app_early_exit"
run_case "case3-early-exit" 1 "$SAMPLE_DEB"
assert_out "case3-early-exit" "exited before writing server.port"

# --- Case 4: port never written, tiny startup budget ---
mkdir -p "$WORK/case4-port-timeout"
touch "$WORK/case4-port-timeout/app_no_port"
CASE_STARTUP_TIMEOUT=1 run_case "case4-port-timeout" 1 "$SAMPLE_DEB"
assert_out "case4-port-timeout" "timed out"

# --- Case 5: Mach-O content in the extracted package ---
mkdir -p "$WORK/case5-macho"
touch "$WORK/case5-macho/macho"
run_case "case5-macho" 1 "$SAMPLE_DEB"
assert_out "case5-macho" "Mach-O content found"

# --- Case 6: no .deb argument ---
run_case "case6-no-arg" 1
assert_out "case6-no-arg" "no .deb specified"

# --- Case 7: secret never leaked on a failure path too ---
mkdir -p "$WORK/case7-no-secret"
touch "$WORK/case7-no-secret/app_no_port"
CASE_STARTUP_TIMEOUT=1 run_case "case7-no-secret" 1 "$SAMPLE_DEB"
refute_out "case7-no-secret" "SHOULD-NOT-LEAK-XYZ"

if [ "$FAILED" -eq 0 ]; then
  echo "ALL SMOKE LINUX SELFTESTS PASSED."
fi
exit "$FAILED"
