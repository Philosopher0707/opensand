set -euo pipefail

# Hermetic selftest for scripts/worktree.sh
# Tests:
#   1. 'new' bases on origin/main even when local main is stale
#   2. 'new' refuses if path or branch already exists
#   3. 'review' creates a detached HEAD worktree
#   4. 'done' refuses dirty worktree
#   5. 'done' refuses unmerged worktree
#   6. 'done' removes clean + merged worktree (leaving remote branches intact)
#   7. 'list' prints worktree status
#   8. 'prune --dry-run' deletes nothing

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_SCRIPT="$ROOT/scripts/worktree.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-worktree-selftest.XXXXXX")
cleanup() {
  chmod -R u+w "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

FAKE_SCRATCH="$WORK/scratch"
mkdir -p "$FAKE_SCRATCH"

# Set up central bare origin
MOCK_ORIGIN="$WORK/mock_origin.git"
git init -b main --bare "$MOCK_ORIGIN" >/dev/null 2>&1 || git init --bare "$MOCK_ORIGIN" >/dev/null

# Establish initial origin/main
MOCK_SEED="$WORK/mock_seed"
git clone "$MOCK_ORIGIN" "$MOCK_SEED" >/dev/null 2>&1
(
  cd "$MOCK_SEED"
  git config user.name "Selftest"
  git config user.email "selftest@example.com"
  printf "node_modules/\ndist/\n" > .gitignore
  echo "commit 1" > file.txt
  git add .gitignore file.txt
  git commit -m "commit 1 on main" >/dev/null
  git branch -M main
  git push origin main >/dev/null 2>&1
)
git -C "$MOCK_ORIGIN" symbolic-ref HEAD refs/heads/main >/dev/null 2>&1 || true

# Advance origin/main with commit 2
(
  cd "$MOCK_SEED"
  echo "commit 2" >> file.txt
  git commit -am "commit 2 on main" >/dev/null
  git push origin main >/dev/null 2>&1
)
ORIGIN_MAIN_SHA=$(git -C "$MOCK_SEED" rev-parse HEAD)

# Create a local clone that intentionally keeps local main stale at commit 1
MOCK_LOCAL="$WORK/mock_local"
git clone "$MOCK_ORIGIN" "$MOCK_LOCAL" >/dev/null 2>&1
git -C "$MOCK_LOCAL" reset --hard HEAD~1 >/dev/null 2>&1
LOCAL_MAIN_SHA=$(git -C "$MOCK_LOCAL" rev-parse HEAD)

if [ "$LOCAL_MAIN_SHA" = "$ORIGIN_MAIN_SHA" ]; then
  echo "FAIL: setup error, local main is not stale"
  exit 1
fi

FAILED=0

# --- Test 1: 'new' bases on origin/main despite stale local main ---
echo "==> Testing 'worktree.sh new' bases on origin/main..."
out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" new test-job
)
NEW_WT="$FAKE_SCRATCH/opensand-test-job"
if [ ! -d "$NEW_WT" ]; then
  echo "FAIL test-1: worktree directory $NEW_WT was not created"
  FAILED=1
fi
WT_BASE_SHA=$(git -C "$NEW_WT" rev-parse HEAD)
if [ "$WT_BASE_SHA" != "$ORIGIN_MAIN_SHA" ]; then
  echo "FAIL test-1: worktree based on $WT_BASE_SHA, expected origin/main $ORIGIN_MAIN_SHA"
  FAILED=1
fi
echo "PASS test-1: new worktree properly based on latest origin/main"

# --- Test 2: 'new' refuses if path or branch already exists ---
echo "==> Testing 'worktree.sh new' duplicate refusal..."
status=0
out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" new test-job 2>&1
) || status=$?
if [ "$status" -eq 0 ]; then
  echo "FAIL test-2: expected refusal on existing path, got success"
  FAILED=1
fi

status=0
out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" new other-job --branch job/test-job 2>&1
) || status=$?
if [ "$status" -eq 0 ]; then
  echo "FAIL test-2: expected refusal on existing branch, got success"
  FAILED=1
fi
echo "PASS test-2: duplicate path and duplicate branch refused"

# --- Test 3: 'review' creates a detached HEAD worktree ---
echo "==> Testing 'worktree.sh review'..."
# Create a dummy review branch on origin
(
  cd "$MOCK_SEED"
  git checkout -b feature-pr99 >/dev/null 2>&1
  echo "pr 99 change" >> file.txt
  git commit -am "pr 99 feature" >/dev/null
  git push origin feature-pr99 >/dev/null 2>&1
  # Push to refs/pull/99/head
  git push origin HEAD:refs/pull/99/head >/dev/null 2>&1
)
PR99_SHA=$(git -C "$MOCK_SEED" rev-parse HEAD)

(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" review 99 >/dev/null
)
REVIEW_WT="$FAKE_SCRATCH/opensand-review-pr99"
if [ ! -d "$REVIEW_WT" ]; then
  echo "FAIL test-3: review worktree was not created"
  FAILED=1
fi
if [ "$(git -C "$REVIEW_WT" rev-parse HEAD)" != "$PR99_SHA" ]; then
  echo "FAIL test-3: review worktree HEAD mismatch"
  FAILED=1
fi
if git -C "$REVIEW_WT" symbolic-ref HEAD >/dev/null 2>&1; then
  echo "FAIL test-3: review worktree should be detached HEAD"
  FAILED=1
fi
echo "PASS test-3: review worktree created as detached HEAD at PR SHA"

# --- Test 4 & 5: 'done' refuses dirty and unmerged worktrees ---
echo "==> Testing 'worktree.sh done' safety guards..."
# Test dirty refusal
echo "uncommitted edit" >> "$NEW_WT/file.txt"
status=0
out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" done test-job 2>&1
) || status=$?
if [ "$status" -eq 0 ]; then
  echo "FAIL test-4: 'done' allowed removal of dirty worktree"
  FAILED=1
fi
echo "$out" | grep -q "has uncommitted changes (dirty)" || {
  echo "FAIL test-4: missing dirty error message"
  FAILED=1
}
echo "PASS test-4: 'done' refused dirty worktree"

# Revert dirty change, commit unmerged change
git -C "$NEW_WT" checkout file.txt
(
  cd "$NEW_WT"
  echo "unmerged commit" >> file.txt
  git commit -am "unmerged work" >/dev/null
)
status=0
out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" done test-job 2>&1
) || status=$?
if [ "$status" -eq 0 ]; then
  echo "FAIL test-5: 'done' allowed removal of unmerged worktree"
  FAILED=1
fi
echo "$out" | grep -q "is not merged into origin/main" || {
  echo "FAIL test-5: missing unmerged error message"
  FAILED=1
}
echo "PASS test-5: 'done' refused unmerged worktree"

# --- Test 6: 'done' removes clean + merged worktree ---
echo "==> Testing 'worktree.sh done' removes clean and merged worktree..."
# Merge the worktree's commit into origin/main via seed clone
(
  cd "$MOCK_SEED"
  git checkout main >/dev/null 2>&1
  git pull origin main >/dev/null 2>&1
  git fetch "$NEW_WT" job/test-job:tmp_merge >/dev/null 2>&1
  git merge --no-edit tmp_merge >/dev/null 2>&1
  git push origin main >/dev/null 2>&1
)
git -C "$MOCK_LOCAL" fetch origin main >/dev/null 2>&1
git -C "$NEW_WT" fetch origin main >/dev/null 2>&1

(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" done test-job >/dev/null
)
if [ -d "$NEW_WT" ]; then
  echo "FAIL test-6: worktree $NEW_WT was not removed"
  FAILED=1
fi
echo "PASS test-6: clean and merged worktree removed cleanly"

# --- Test 7 & 8: 'list' and 'prune --dry-run' ---
echo "==> Testing 'worktree.sh list' and 'worktree.sh prune --dry-run'..."
# Create one clean+merged worktree and one unmerged worktree
git -C "$MOCK_LOCAL" worktree add "$FAKE_SCRATCH/opensand-merged-sample" origin/main >/dev/null 2>&1
git -C "$MOCK_LOCAL" worktree add -b sample-unmerged "$FAKE_SCRATCH/opensand-unmerged-sample" origin/main >/dev/null 2>&1
(
  cd "$FAKE_SCRATCH/opensand-unmerged-sample"
  echo "unmerged sample" >> file.txt
  git commit -am "unmerged sample commit" >/dev/null
)

list_out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" list
)
echo "$list_out" | grep -q "opensand-merged-sample" || {
  echo "FAIL test-7: list output missing opensand-merged-sample"
  FAILED=1
}
echo "$list_out" | grep -q "opensand-unmerged-sample" || {
  echo "FAIL test-7: list output missing opensand-unmerged-sample"
  FAILED=1
}
echo "PASS test-7: list displays active worktrees"

prune_out=$(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" prune --dry-run
)
echo "$prune_out" | grep -q "DRY RUN: would remove opensand-merged-sample" || {
  echo "FAIL test-8: prune dry-run missing expected target"
  FAILED=1
}
if [ ! -d "$FAKE_SCRATCH/opensand-merged-sample" ]; then
  echo "FAIL test-8: prune dry-run deleted worktree directory!"
  FAILED=1
fi
echo "PASS test-8: prune --dry-run reports targets without deleting"

if [ "$FAILED" -eq 0 ]; then
  echo "ALL WORKTREE SELFTESTS PASSED."
fi

exit "$FAILED"
