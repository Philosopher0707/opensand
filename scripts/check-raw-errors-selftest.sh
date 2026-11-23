#!/usr/bin/env bash
# Hermetic selftest for check-raw-errors.sh: a clean fixture passes, a planted raw error fails.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${RAW_ERRORS_CHECK_SCRIPT:-$SCRIPT_DIR/check-raw-errors.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-raw-errors-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

mkdir -p "$WORK/scan/src"
ALLOW="$WORK/allow.txt"
printf '# test allowlist\n' > "$ALLOW"
cat > "$WORK/scan/src/clean.ts" <<'EOF'
import { classifyError } from './errors';
res.end(JSON.stringify({ error: classifyError(err).cause }));
console.error("failed", err.message);
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
EOF
cat > "$WORK/scan/src/dirty.ts" <<'EOF'
res.end(JSON.stringify({ error: err.message }));
this.emitEvent('error', { message: String(err) });
EOF

OUT=""
STATUS=0
run_check() {
  OUT="$(RAW_ERRORS_SCAN_DIR="$WORK/scan" RAW_ERRORS_ALLOW="$ALLOW" RAW_ERRORS_ROOT="$WORK" bash "$CHECK" 2>&1)"
  STATUS=$?
}

run_check
if [[ "$STATUS" -eq 1 ]] && grep -qF 'dirty.ts:1' <<<"$OUT" && grep -qF 'dirty.ts:2' <<<"$OUT" \
   && ! grep -qF 'clean.ts' <<<"$OUT"; then
  pass "raw response/event errors are found; classified, logged and helper lines are not"
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

echo 'setToast({ tone: "bad", message: e.message });' >> "$WORK/scan/src/clean.ts"
run_check
if [[ "$STATUS" -eq 1 ]] && grep -qF 'clean.ts:5' <<<"$OUT"; then
  pass "a new raw error in a toast fails the check and is named"
else
  fail "planted raw error (exit $STATUS): $OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: check-raw-errors selftest failed" >&2
  exit 1
fi
echo "PASS: check-raw-errors selftest ok"
