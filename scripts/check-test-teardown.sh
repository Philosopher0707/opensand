#!/usr/bin/env bash
# A desktop test that owns a bridge or server in-process must tear it down with
# test/teardown.ts closeThenRemove() before deleting its temp dir. A bare rmSync can run while
# the bridge is still creating its vault directory asynchronously, and the rmdir then fails
# ENOTEMPTY (docs/lessons/2026-11-24-main-ci-red-after-pr-209-merge.md).
# Usage: scripts/check-test-teardown.sh   (DESKTOP_TEST_DIR overrides the test directory)
# Exit 0 every such file uses the helper, 1 one does not, 2 the test directory is missing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="${DESKTOP_TEST_DIR:-$ROOT/packages/desktop/test}"

if [[ ! -d "$TEST_DIR" ]]; then
  echo "FAIL: desktop test directory not found: $TEST_DIR" >&2
  exit 2
fi

FAILED=0
CHECKED=0
while IFS= read -r file; do
  grep -qE '\b(DesktopIpcBridge|DesktopServer|DesktopApp)\b|getBridge\(' "$file" || continue
  CHECKED=$((CHECKED + 1))
  if hits=$(grep -nE 'rmSync\(' "$file"); then
    echo "FAIL: ${file#$ROOT/} owns a bridge/server and removes a directory with a bare rmSync:" >&2
    echo "$hits" >&2
    echo "  use closeThenRemove([bridge], dir) from test/teardown.ts, which awaits the shutdown first" >&2
    FAILED=1
  fi
done < <(find "$TEST_DIR" -maxdepth 1 -type f -name '*.test.ts' | LC_ALL=C sort)

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
echo "PASS: $CHECKED desktop test file(s) that own a bridge/server close through teardown.ts."
exit 0
