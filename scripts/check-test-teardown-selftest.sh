#!/usr/bin/env bash
# Hermetic selftest for check-test-teardown.sh: an offending fixture fails and is named, the same
# file with closeThenRemove passes, and a file with no bridge is never inspected.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${TEST_TEARDOWN_CHECK_SCRIPT:-$SCRIPT_DIR/check-test-teardown.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-test-teardown-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

mkdir -p "$WORK/tests"
cat > "$WORK/tests/bridge-home.test.ts" << 'FIXTURE'
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
test('x', async () => {
  const bridge = new DesktopIpcBridge({ baseDir: '/tmp/x' });
  await bridge.close();
  fs.rmSync(home, { recursive: true, force: true });
});
FIXTURE
cat > "$WORK/tests/plain.test.ts" << 'FIXTURE'
test('x', async () => {
  fs.rmSync(home, { recursive: true, force: true });
});
FIXTURE

OUT=""
STATUS=0
run_check() {
  OUT="$(DESKTOP_TEST_DIR="$WORK/tests" bash "$CHECK" 2>&1)"
  STATUS=$?
}

run_check
if [[ "$STATUS" -eq 1 ]] && grep -qF 'bridge-home.test.ts' <<<"$OUT" && ! grep -qF 'plain.test.ts' <<<"$OUT"; then
  pass "a bare rmSync in a bridge-owning test fails and is named; a file with no bridge is skipped"
else
  fail "offending fixture (exit $STATUS): $OUT"
fi

cat > "$WORK/tests/bridge-home.test.ts" << 'FIXTURE'
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { closeThenRemove } from './teardown.js';
test('x', async () => {
  const bridge = new DesktopIpcBridge({ baseDir: '/tmp/x' });
  await closeThenRemove([bridge], home);
});
FIXTURE

run_check
if [[ "$STATUS" -eq 0 ]]; then
  pass "the same test with closeThenRemove passes"
else
  fail "fixed fixture (exit $STATUS): $OUT"
fi

OUT="$(DESKTOP_TEST_DIR="$WORK/missing" bash "$CHECK" 2>&1)"
STATUS=$?
if [[ "$STATUS" -eq 2 ]]; then
  pass "a missing test directory exits 2"
else
  fail "missing directory (exit $STATUS): $OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: check-test-teardown selftest failed" >&2
  exit 1
fi
echo "PASS: check-test-teardown selftest ok"
