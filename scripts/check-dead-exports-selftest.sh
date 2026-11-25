#!/usr/bin/env bash
# Hermetic selftest for check-dead-exports.sh: a clean fixture passes, a planted dead export fails.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${DEAD_EXPORTS_CHECK_SCRIPT:-$SCRIPT_DIR/check-dead-exports.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-dead-exports-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

mkdir -p "$WORK/pkgs/alpha/src"
ALLOW="$WORK/allow.txt"
printf '# test allowlist\n' > "$ALLOW"
cat > "$WORK/pkgs/alpha/src/a.ts" <<'EOF'
export function used() { return 1; }
export function dead() { return 2; }
export const CONST_A = 3;
export function nextOnly() { return 5; }
EOF
cat > "$WORK/pkgs/alpha/src/b.ts" <<'EOF'
import { used, CONST_A } from './a';
console.log(used(), CONST_A);
EOF
# The second front-end tree is a referencing consumer, not a source of findings.
mkdir -p "$WORK/pkgs/alpha/renderer-next/src"
cat > "$WORK/pkgs/alpha/renderer-next/src/view.tsx" <<'EOF'
import { nextOnly } from '../../src/a';
console.log(nextOnly());
EOF

OUT=""
STATUS=0
run_check() {
  OUT="$(DEAD_EXPORTS_PACKAGES_DIR="$WORK/pkgs" DEAD_EXPORTS_ALLOW="$ALLOW" DEAD_EXPORTS_ROOT="$WORK" bash "$CHECK" 2>&1)"
  STATUS=$?
}

run_check
if [[ "$STATUS" -eq 1 ]] && grep -qF 'function dead' <<<"$OUT" && ! grep -qF 'function used' <<<"$OUT" && ! grep -qF 'function nextOnly' <<<"$OUT"; then
  pass "unreferenced export is found; imports from src and renderer-next are not"
else
  fail "baseline (exit $STATUS): $OUT"
fi

grep '^FINDING ' <<<"$OUT" | sed 's/^FINDING //' >> "$ALLOW"
run_check
if [[ "$STATUS" -eq 0 ]]; then
  pass "seeded allowlist makes the fixture pass"
else
  fail "seeded allowlist (exit $STATUS): $OUT"
fi

# A real import from another file must make an export live again.
echo "import { dead } from './a'; dead();" >> "$WORK/pkgs/alpha/src/b.ts"
run_check
if [[ "$STATUS" -eq 0 ]] && ! grep -qF 'function dead' <<<"$OUT"; then
  pass "an import from another file removes the finding"
else
  fail "cross-file import (exit $STATUS): $OUT"
fi

echo 'export function freshDead() { return 4; }' >> "$WORK/pkgs/alpha/src/a.ts"
run_check
if [[ "$STATUS" -eq 1 ]] && grep -qF 'function freshDead' <<<"$OUT"; then
  pass "a new dead export fails the check and is named"
else
  fail "planted dead export (exit $STATUS): $OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: check-dead-exports selftest failed" >&2
  exit 1
fi
echo "PASS: check-dead-exports selftest ok"
