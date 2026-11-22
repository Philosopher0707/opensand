#!/usr/bin/env bash
# Hermetic selftest for the owner checkout protection guard (scripts/lib/owner-guard.sh)
# and its integration into scripts/worktree.sh and scripts/pr-gate.sh.
#
# Verifies:
#   1. Refuses with exit 4 when running in the protected checkout repo.
#   2. Refuses with exit 4 when running in a worktree linked to the protected checkout.
#   3. Passes (exit 0) when running in an independent clone (e.g. opensand-base).
#   4. Passes (exit 0) when running in a worktree linked to the independent clone.
#   5. Passes (exit 0) when OPENSAND_OWNER=1 override is set, even in the protected repo.
#   6. scripts/worktree.sh exits 4 with expected message in protected checkout.
#   7. scripts/pr-gate.sh exits 4 with expected message in protected checkout.
#   8. OPENSAND_OWNER=1 allows scripts/worktree.sh past owner guard.
#   9. Mutation test: removing the guard call causes the refusal check to fail.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD_SCRIPT="$ROOT/scripts/lib/owner-guard.sh"
WORKTREE_SCRIPT="$ROOT/scripts/worktree.sh"
PR_GATE_SCRIPT="$ROOT/scripts/pr-gate.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-owner-guard-selftest.XXXXXX")
cleanup() {
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

FAILED=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILED=1; }

echo "==> Setting up hermetic git repositories in $WORK..."
PROTECTED_REPO="$WORK/protected-repo"
UNPROTECTED_REPO="$WORK/unprotected-repo"

git init --quiet "$PROTECTED_REPO"
git -C "$PROTECTED_REPO" config user.email "test@example.com"
git -C "$PROTECTED_REPO" config user.name "Test"
git -C "$PROTECTED_REPO" commit --allow-empty --quiet -m "init"

# Worktree linked to protected-repo
PROTECTED_WT="$WORK/protected-worktree"
git -C "$PROTECTED_REPO" worktree add --quiet -b prot-wt "$PROTECTED_WT"

git init --quiet "$UNPROTECTED_REPO"
git -C "$UNPROTECTED_REPO" config user.email "test@example.com"
git -C "$UNPROTECTED_REPO" config user.name "Test"
git -C "$UNPROTECTED_REPO" commit --allow-empty --quiet -m "init"

# Worktree linked to unprotected-repo
UNPROTECTED_WT="$WORK/unprotected-worktree"
git -C "$UNPROTECTED_REPO" worktree add --quiet -b unprot-wt "$UNPROTECTED_WT"

# 1. Guard refuses in protected repository with exit 4
echo "==> Testing guard refusal in protected repository..."
STATUS=0
OUT=""
OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_REPO' && bash '$GUARD_SCRIPT' 'worktree.sh'" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 4 ]] && grep -qF "worktree.sh: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base" <<<"$OUT"; then
  pass "guard refuses in protected repo with exit 4 and expected error message"
else
  fail "guard in protected repo exited $STATUS (want 4) with output: $OUT"
fi

# 2. Guard refuses in linked worktree of protected repository with exit 4
echo "==> Testing guard refusal in worktree linked to protected repository..."
STATUS=0
OUT=""
OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_WT' && bash '$GUARD_SCRIPT' 'worktree.sh'" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 4 ]] && grep -qF "worktree.sh: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base" <<<"$OUT"; then
  pass "guard refuses in linked worktree of protected repo with exit 4"
else
  fail "guard in linked worktree exited $STATUS (want 4) with output: $OUT"
fi

# 3. Guard passes in independent repository
echo "==> Testing guard passes in independent repository..."
STATUS=0
OUT=""
OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$UNPROTECTED_REPO' && bash '$GUARD_SCRIPT' 'worktree.sh'" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 0 ]]; then
  pass "guard passes in independent repository"
else
  fail "guard in independent repo exited $STATUS (want 0) with output: $OUT"
fi

# 4. Guard passes in linked worktree of independent repository
echo "==> Testing guard passes in worktree of independent repository..."
STATUS=0
OUT=""
OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$UNPROTECTED_WT' && bash '$GUARD_SCRIPT' 'worktree.sh'" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 0 ]]; then
  pass "guard passes in linked worktree of independent repository"
else
  fail "guard in linked worktree of independent repo exited $STATUS (want 0) with output: $OUT"
fi

# 5. OPENSAND_OWNER=1 override allows running in protected repository and linked worktree
echo "==> Testing OPENSAND_OWNER=1 override..."
STATUS=0
OUT=""
OUT=$(OPENSAND_OWNER=1 OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_REPO' && bash '$GUARD_SCRIPT' 'worktree.sh'" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 0 ]]; then
  pass "OPENSAND_OWNER=1 override passes in protected repository"
else
  fail "OPENSAND_OWNER=1 in protected repo exited $STATUS (want 0) with output: $OUT"
fi

STATUS=0
OUT=""
OUT=$(OPENSAND_OWNER=1 OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_WT' && bash '$GUARD_SCRIPT' 'worktree.sh'" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 0 ]]; then
  pass "OPENSAND_OWNER=1 override passes in linked worktree of protected repository"
else
  fail "OPENSAND_OWNER=1 in linked worktree exited $STATUS (want 0) with output: $OUT"
fi

# 6. scripts/worktree.sh integration: exits 4 with expected message
echo "==> Testing scripts/worktree.sh integration..."
STATUS=0
OUT=""
OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_REPO' && bash '$WORKTREE_SCRIPT' list" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 4 ]] && grep -qF "worktree.sh: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base" <<<"$OUT"; then
  pass "scripts/worktree.sh exits 4 with owner refusal message"
else
  fail "scripts/worktree.sh exited $STATUS (want 4) with output: $OUT"
fi

# 7. scripts/pr-gate.sh integration: exits 4 with expected message
echo "==> Testing scripts/pr-gate.sh integration..."
STATUS=0
OUT=""
OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_REPO' && bash '$PR_GATE_SCRIPT' 999" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 4 ]] && grep -qF "pr-gate.sh: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base" <<<"$OUT"; then
  pass "scripts/pr-gate.sh exits 4 with owner refusal message"
else
  fail "scripts/pr-gate.sh exited $STATUS (want 4) with output: $OUT"
fi

# 8. OPENSAND_OWNER=1 allows scripts/worktree.sh past owner guard
echo "==> Testing OPENSAND_OWNER=1 on scripts/worktree.sh..."
STATUS=0
OUT=""
OUT=$(OPENSAND_OWNER=1 OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" OPENSAND_SCRATCH_DIR="$WORK/scratch" bash -c "cd '$PROTECTED_REPO' && bash '$WORKTREE_SCRIPT' list" 2>&1) || STATUS=$?

if [[ "$STATUS" -eq 0 ]] && grep -qF "OpenSand worktrees" <<<"$OUT"; then
  pass "scripts/worktree.sh succeeds with OPENSAND_OWNER=1"
else
  fail "scripts/worktree.sh with OPENSAND_OWNER=1 failed (exit $STATUS): $OUT"
fi

# 9. Mutation check: removing guard call causes refusal check to fail (exit != 4)
echo "==> Testing mutation check..."
MUTANT_GUARD="$WORK/mutant-guard.sh"
# Mutation: guard body returns 0 instead of refusing
sed 's/exit 4/return 0/' "$GUARD_SCRIPT" > "$MUTANT_GUARD"

M_STATUS=0
M_OUT=$(OPENSAND_PROTECTED_CHECKOUT="$PROTECTED_REPO" bash -c "cd '$PROTECTED_REPO' && bash '$MUTANT_GUARD' 'worktree.sh'" 2>&1) || M_STATUS=$?

if [[ "$M_STATUS" -ne 4 ]]; then
  pass "mutation check: mutant without exit 4 fails refusal check (exited $M_STATUS instead of 4)"
else
  fail "mutation check: mutant unexpectedly exited 4: $M_OUT"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "FAIL: owner-guard selftest failed." >&2
  exit 1
fi

echo "ALL OWNER GUARD SELFTESTS PASSED."
exit 0
