#!/usr/bin/env bash
# Hermetic selftest for scripts/lint-brief.sh (no network, no repo writes).
# Point LINT_BRIEF_SCRIPT at a mutant copy to prove a case sees the breakage.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT="${LINT_BRIEF_SCRIPT:-$SCRIPT_DIR/lint-brief.sh}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opensand-lint-brief-selftest.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

FAILED=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }

LAST_OUT=""
LAST_STATUS=0
run_lint() {
  LAST_OUT="$("$LINT" "$@" 2>&1)"
  LAST_STATUS=$?
}
expect() { # <status> <substring|-> <name> <args...>
  local want_status="$1" want_text="$2" name="$3"
  shift 3
  run_lint "$@"
  if [[ "$LAST_STATUS" -ne "$want_status" ]]; then
    fail "$name (exit $LAST_STATUS, want $want_status): $LAST_OUT"
    return
  fi
  if [[ "$want_text" != "-" ]] && ! grep -qF -- "$want_text" <<<"$LAST_OUT"; then
    fail "$name (missing '$want_text'): $LAST_OUT"
    return
  fi
  pass "$name"
}

cat > "$TMP_DIR/valid.md" <<'EOF'
Goal: close the two process gaps.
Done when: the lint PR is merged and main CI is green.
Scope: scripts/ and docs/ only.
Report back with: PR number, merge commit, selftest output.
EOF

cat > "$TMP_DIR/valid-headings.md" <<'EOF'
## Goal
Close the gap.
## Done when
CI green.
## Scope
scripts/ only.
## Report back
PR number.
EOF

cat > "$TMP_DIR/no-goal.md" <<'EOF'
Done when: CI green.
Scope: scripts/ only.
Report back: PR number.
EOF
cat > "$TMP_DIR/no-done.md" <<'EOF'
Goal: fix it.
Scope: scripts/ only.
Report back: PR number.
EOF
cat > "$TMP_DIR/no-scope.md" <<'EOF'
Goal: fix it.
Done when: CI green.
Report back: PR number.
EOF
cat > "$TMP_DIR/no-report.md" <<'EOF'
Goal: fix it.
Done when: CI green.
Scope: scripts/ only.
EOF
: > "$TMP_DIR/empty.md"

cat > "$TMP_DIR/has-todo.md" <<'EOF'
Goal: fix it.
Done when: CI green.
Scope: TODO: need scope details.
Report back: PR number.
EOF

expect 0 "PASS" "colon-style brief passes" "$TMP_DIR/valid.md"
expect 0 "PASS" "markdown-heading brief passes" "$TMP_DIR/valid-headings.md"
expect 1 "missing sections: Goal" "missing Goal is caught" "$TMP_DIR/no-goal.md"
expect 1 "Done when" "missing Done when is caught" "$TMP_DIR/no-done.md"
expect 1 "missing sections: Scope" "missing Scope is caught" "$TMP_DIR/no-scope.md"
expect 1 "Report back" "missing Report back is caught" "$TMP_DIR/no-report.md"
expect 1 "contains unresolved TODO" "brief with TODO is rejected" "$TMP_DIR/has-todo.md"
run_lint "$TMP_DIR/empty.md"
if [[ "$LAST_STATUS" -eq 1 ]] && grep -qF "Goal" <<<"$LAST_OUT" && grep -qF "Report back" <<<"$LAST_OUT"; then
  pass "empty brief names all four missing sections"
else
  fail "empty brief (exit $LAST_STATUS): $LAST_OUT"
fi
expect 1 "missing sections" "one bad brief fails a batch" "$TMP_DIR/valid.md" "$TMP_DIR/no-scope.md"
expect 2 "Usage" "no arguments is a usage error"
expect 2 "cannot read" "unreadable brief is a usage error" "$TMP_DIR/absent.md"

# stdin form: a good brief on stdin passes, a bad one fails.
LAST_OUT="$(cat "$TMP_DIR/valid.md" | "$LINT" - 2>&1)"; LAST_STATUS=$?
if [[ "$LAST_STATUS" -eq 0 ]]; then pass "valid brief on stdin passes"; else fail "valid brief on stdin: $LAST_OUT"; fi
LAST_OUT="$(cat "$TMP_DIR/no-scope.md" | "$LINT" - 2>&1)"; LAST_STATUS=$?
if [[ "$LAST_STATUS" -eq 1 ]] && grep -qF "Scope" <<<"$LAST_OUT"; then
  pass "bad brief on stdin fails"
else
  fail "bad brief on stdin (exit $LAST_STATUS): $LAST_OUT"
fi
LAST_OUT="$(cat "$TMP_DIR/has-todo.md" | "$LINT" - 2>&1)"; LAST_STATUS=$?
if [[ "$LAST_STATUS" -eq 1 ]] && grep -qF "contains unresolved TODO" <<<"$LAST_OUT"; then
  pass "brief with TODO on stdin fails"
else
  fail "brief with TODO on stdin (exit $LAST_STATUS): $LAST_OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: lint-brief selftest failed" >&2
  exit 1
fi
echo "PASS: lint-brief selftest ok"
