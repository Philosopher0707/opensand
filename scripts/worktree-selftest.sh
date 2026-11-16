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
#  10. 'base' creates and refreshes the reusable base clone; 'new' hangs worktrees off it; the base
#      clone is never removed or pruned; 'done' also drops the merged local branch so the name is reusable
#   9. Live rule: 'prune --yes' keeps worktrees whose branch has an OPEN PR or with a file
#      changed in the last 2 hours, and fails closed when the PR state cannot be read
#  11. 'save' stages by explicit path, refuses secrets (nothing committed or pushed), commits with the
#      hooks on (a failing hook stops the push), verifies the push, opens a draft PR once on the first
#      push, and refuses outside a job worktree; 'done' refuses unpushed work

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

# Stubbed gh (no shebang, AGENTS_LEARNING 12.27): `gh pr list --head <b>` counts <b> in $GH_OPEN_PR_BRANCHES
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"
cat << 'EOS' > "$STUB_BIN/gh"
if [ -n "${GH_STUB_FAIL:-}" ]; then
  echo "gh stub: simulated failure" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "gh $*" >> "$GH_CREATE_LOG"
  head=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--head" ]; then head="$2"; fi
    shift
  done
  echo "$head" >> "$GH_OPEN_PR_BRANCHES"
  echo "https://github.com/example/opensand/pull/777"
  exit 0
fi
branch=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--head" ]; then branch="$2"; fi
  shift
done
if [ -n "$branch" ] && grep -qx -- "$branch" "$GH_OPEN_PR_BRANCHES" 2>/dev/null; then
  echo 1
else
  echo 0
fi
EOS
chmod +x "$STUB_BIN/gh"
export GH_OPEN_PR_BRANCHES="$WORK/open_pr_branches"
: > "$GH_OPEN_PR_BRANCHES"
export GH_CREATE_LOG="$WORK/pr_create.log"
export GIT_AUTHOR_NAME="Selftest" GIT_AUTHOR_EMAIL="selftest@example.com"
export GIT_COMMITTER_NAME="Selftest" GIT_COMMITTER_EMAIL="selftest@example.com"
export PATH="$STUB_BIN:$PATH"

# Backdate every file outside .git so the 2-hour live rule does not trip on checkout files
age_files() {
  find "$1" -path "$1/.git" -prune -o -exec touch -t 202001010000 {} +
}

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

# 'new' and 'base' clone from the mock origin into <scratch>/opensand-base
export OPENSAND_REPO_URL="$MOCK_ORIGIN"
BASE_CLONE="$FAKE_SCRATCH/opensand-base"

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
  git push -q origin job/test-job:refs/heads/scratch-test5
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

# Live samples: clean + merged + old files, but one has an OPEN PR and one has a fresh file
git -C "$MOCK_LOCAL" worktree add -b sample-open-pr "$FAKE_SCRATCH/opensand-open-pr-sample" origin/main >/dev/null 2>&1
echo "sample-open-pr" >> "$GH_OPEN_PR_BRANCHES"
git -C "$MOCK_LOCAL" worktree add -b sample-branched "$FAKE_SCRATCH/opensand-branched-sample" origin/main >/dev/null 2>&1
git -C "$MOCK_LOCAL" worktree add -b sample-recent "$FAKE_SCRATCH/opensand-recent-sample" origin/main >/dev/null 2>&1
for wt in opensand-merged-sample opensand-unmerged-sample opensand-open-pr-sample opensand-branched-sample opensand-recent-sample; do
  age_files "$FAKE_SCRATCH/$wt"
done
mkdir -p "$FAKE_SCRATCH/opensand-recent-sample/node_modules"
touch "$FAKE_SCRATCH/opensand-recent-sample/node_modules/fresh.log"

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
echo "$prune_out" | grep -q "opensand-open-pr-sample" && {
  echo "FAIL test-8: prune dry-run listed an OPEN-PR worktree"
  FAILED=1
}
echo "$prune_out" | grep -q "opensand-recent-sample" && {
  echo "FAIL test-8: prune dry-run listed a recently-changed worktree"
  FAILED=1
}
echo "PASS test-8: prune --dry-run reports targets without deleting"

# --- Test 9: live rule on 'prune --yes' ---
echo "==> Testing live rule on 'worktree.sh prune --yes'..."
# Fail closed: gh failing means no worktree that has a branch may be pruned
fail_out=$(
  cd "$MOCK_LOCAL" && \
  GH_STUB_FAIL=1 OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" prune --yes
)
if [ ! -d "$FAKE_SCRATCH/opensand-branched-sample" ]; then
  echo "FAIL test-9: prune --yes removed a branched worktree while gh failed (must fail closed)"
  FAILED=1
fi

(
  cd "$MOCK_LOCAL" && \
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" \
  bash "$WORKTREE_SCRIPT" prune --yes >/dev/null
)
if [ -d "$FAKE_SCRATCH/opensand-merged-sample" ] || [ -d "$FAKE_SCRATCH/opensand-branched-sample" ]; then
  echo "FAIL test-9: old, clean, merged, no-PR worktree was not pruned"
  FAILED=1
fi
if [ ! -d "$FAKE_SCRATCH/opensand-open-pr-sample" ]; then
  echo "FAIL test-9: prune removed a worktree whose branch has an OPEN PR"
  FAILED=1
fi
if [ ! -d "$FAKE_SCRATCH/opensand-recent-sample" ]; then
  echo "FAIL test-9: prune removed a worktree with a file changed in the last 2h"
  FAILED=1
fi
if [ ! -d "$FAKE_SCRATCH/opensand-unmerged-sample" ]; then
  echo "FAIL test-9: prune removed an unmerged worktree"
  FAILED=1
fi
echo "PASS test-9: prune --yes removed only old, clean, merged, PR-less worktrees"

# --- Test 10: base clone ---
echo "==> Testing 'worktree.sh base' and base-clone protection..."
# Test 1 created the base clone through 'new'; it must be a detached, clean clone owning the worktrees
if [ ! -d "$BASE_CLONE/.git" ]; then
  echo "FAIL test-10: 'new' did not create the base clone at $BASE_CLONE"
  FAILED=1
fi
if git -C "$BASE_CLONE" symbolic-ref HEAD >/dev/null 2>&1; then
  echo "FAIL test-10: base clone should be detached at origin/main"
  FAILED=1
fi

# Advance origin/main, then 'base' must refresh the existing clone
(
  cd "$MOCK_SEED"
  git checkout main >/dev/null 2>&1
  echo "commit after base" >> file.txt
  git commit -am "advance main for base refresh" >/dev/null
  git push origin main >/dev/null 2>&1
)
NEWER_SHA=$(git -C "$MOCK_SEED" rev-parse HEAD)
base_out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" base 2>&1)
if [ "$(git -C "$BASE_CLONE" rev-parse HEAD)" != "$NEWER_SHA" ]; then
  echo "FAIL test-10: 'base' did not refresh the clone to origin/main $NEWER_SHA"
  FAILED=1
fi
echo "$base_out" | grep -q "Base clone: $BASE_CLONE at" || {
  echo "FAIL test-10: 'base' did not report the clone path and SHA"
  FAILED=1
}

# 'base' creates the clone from nothing in a custom location
CUSTOM_BASE="$WORK/custom-base"
(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" OPENSAND_BASE_DIR="$CUSTOM_BASE" bash "$WORKTREE_SCRIPT" base >/dev/null 2>&1)
if [ "$(git -C "$CUSTOM_BASE" rev-parse HEAD 2>/dev/null)" != "$NEWER_SHA" ]; then
  echo "FAIL test-10: 'base' did not create a fresh clone at OPENSAND_BASE_DIR"
  FAILED=1
fi

# A dirty base clone is refused (nobody works there)
echo "stray" > "$CUSTOM_BASE/stray.txt"
status=0
out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" OPENSAND_BASE_DIR="$CUSTOM_BASE" bash "$WORKTREE_SCRIPT" base 2>&1) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "has uncommitted changes"; then
  echo "FAIL test-10: 'base' accepted a dirty base clone (status $status)"
  FAILED=1
fi

# A non-git directory at the base path is refused
mkdir -p "$WORK/not-a-clone"
status=0
out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" OPENSAND_BASE_DIR="$WORK/not-a-clone" bash "$WORKTREE_SCRIPT" base 2>&1) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "is not a git clone"; then
  echo "FAIL test-10: 'base' accepted a non-git directory (status $status)"
  FAILED=1
fi

# The protected application and repository paths are refused as base locations
status=0
out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" OPENSAND_BASE_DIR="$HOME/.opensand/base-selftest" bash "$WORKTREE_SCRIPT" base 2>&1) || status=$?
if [ "$status" -eq 0 ] || [ -e "$HOME/.opensand/base-selftest" ]; then
  echo "FAIL test-10: 'base' accepted a protected path (status $status)"
  FAILED=1
fi

# The base clone owns worktrees and is old, clean and at origin/main, yet prune and done must keep it
age_files "$BASE_CLONE"
git -C "$BASE_CLONE" worktree add -b base-owned "$FAKE_SCRATCH/opensand-base-owned" origin/main >/dev/null 2>&1
age_files "$FAKE_SCRATCH/opensand-base-owned"
(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" prune --yes >/dev/null 2>&1)
if [ ! -d "$BASE_CLONE/.git" ]; then
  echo "FAIL test-10: prune --yes removed the base clone"
  FAILED=1
fi
if [ -d "$FAKE_SCRATCH/opensand-base-owned" ]; then
  echo "FAIL test-10: prune --yes did not remove a clean, merged worktree owned by the base clone"
  FAILED=1
fi
if git -C "$BASE_CLONE" worktree list --porcelain | grep -q "opensand-base-owned"; then
  echo "FAIL test-10: base clone still lists the pruned worktree (removal must go through the owning repo)"
  FAILED=1
fi
status=0
out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" done base 2>&1) || status=$?
if [ "$status" -eq 0 ] || [ ! -d "$BASE_CLONE/.git" ] || ! echo "$out" | grep -q "protected repository"; then
  echo "FAIL test-10: 'done' did not refuse the base clone (status $status)"
  FAILED=1
fi
# A primary clone that owns worktrees is protected even outside the base location
OWNER="$FAKE_SCRATCH/opensand-owner-clone"
git clone --quiet "$MOCK_ORIGIN" "$OWNER" >/dev/null 2>&1
git -C "$OWNER" worktree add -b owner-child "$WORK/owner-child" origin/main >/dev/null 2>&1
status=0
out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" done owner-clone 2>&1) || status=$?
if [ "$status" -eq 0 ] || [ ! -d "$OWNER/.git" ]; then
  echo "FAIL test-10: 'done' removed a clone that owns worktrees (status $status)"
  FAILED=1
fi

# 'new' from a worktree's own directory (not the caller's repo) works, and after 'done' the same
# job name is reusable because the merged local branch was dropped (test 6 removed job/test-job)
if git -C "$BASE_CLONE" show-ref --verify --quiet refs/heads/job/test-job; then
  echo "FAIL test-10: 'done' left the merged local branch job/test-job behind"
  FAILED=1
fi
(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" new test-job >/dev/null 2>&1)
if [ "$(git -C "$FAKE_SCRATCH/opensand-test-job" rev-parse HEAD 2>/dev/null)" != "$NEWER_SHA" ]; then
  echo "FAIL test-10: 'new test-job' after 'done' did not create a worktree at the refreshed origin/main"
  FAILED=1
fi
# A branch that exists only on the remote is refused (asked live, not from a stale ref)
status=0
out=$(cd "$MOCK_LOCAL" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" new remote-only --branch feature-pr99 2>&1) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "already exists on remote origin"; then
  echo "FAIL test-10: 'new' accepted a branch that exists on the remote (status $status)"
  FAILED=1
fi
echo "PASS test-10: base clone created, refreshed, protected; worktrees removed via the owning repo"


# --- Test 11: save / done-refuses-unpushed ---
echo "==> Testing 'worktree.sh save' and unpushed-work refusal..."
run_wt() { # run_wt <dir> <args...>: run worktree.sh inside <dir>, merged stdout+stderr
  local d="$1"; shift
  (cd "$d" && OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$WORKTREE_SCRIPT" "$@" 2>&1)
}
fake_token() { # built at runtime so this file never holds a real-looking secret (push protection)
  case "$1" in
    sk)  printf '%s%s' 'sk' '-abcdefghij0123456789ABCDEFGH' ;;
    ghp) printf '%s%s' 'gh' 'p_abcdefghij0123456789ABCDEFGHIJ0123' ;;
    aws) printf '%s%s' 'AK' 'IAABCDEFGHIJKLMNOP' ;;
    pem) printf '%s%s' '-----BEGIN ' 'PRIVATE KEY-----' ;;
  esac
}
remote_sha() { git -C "$MOCK_ORIGIN" rev-parse "refs/heads/$1" 2>/dev/null || echo none; }

run_wt "$MOCK_LOCAL" new save-job >/dev/null
SAVE_WT="$FAKE_SCRATCH/opensand-save-job"
age_files "$SAVE_WT"

# 11a. plain save: explicit-path staging of modified + new files (ignored ones stay out), hooks-on
#      commit, verified push, exactly one draft PR
echo "tracked edit" >> "$SAVE_WT/file.txt"
echo "brand new" > "$SAVE_WT/new.txt"
mkdir -p "$SAVE_WT/dist"; echo "build output" > "$SAVE_WT/dist/out.js"
status=0; out=$(run_wt "$SAVE_WT" save "selftest: first save") || status=$?
[ "$status" -eq 0 ] || { echo "FAIL test-11a: save exit $status: $out"; FAILED=1; }
[ "$(git -C "$SAVE_WT" log -1 --format=%s)" = "selftest: first save" ] || { echo "FAIL test-11a: commit message not used"; FAILED=1; }
git -C "$SAVE_WT" cat-file -e HEAD:new.txt 2>/dev/null || { echo "FAIL test-11a: the new file was not committed"; FAILED=1; }
if git -C "$SAVE_WT" cat-file -e HEAD:dist/out.js 2>/dev/null; then echo "FAIL test-11a: an ignored file was committed"; FAILED=1; fi
[ "$(remote_sha job/save-job)" = "$(git -C "$SAVE_WT" rev-parse HEAD)" ] || { echo "FAIL test-11a: remote branch is not at HEAD"; FAILED=1; }
echo "$out" | grep -q "verified on the remote" || { echo "FAIL test-11a: no push verification line"; FAILED=1; }
echo "$out" | grep -q "Draft PR: https://github.com/example/opensand/pull/777" || { echo "FAIL test-11a: draft PR not reported: $out"; FAILED=1; }
if [ "$(grep -c -- '--draft' "$GH_CREATE_LOG")" -ne 1 ] || ! grep -q -- '--head job/save-job' "$GH_CREATE_LOG"; then
  echo "FAIL test-11a: expected exactly one 'gh pr create --draft --head job/save-job'"; FAILED=1
fi

# 11b. second save reuses the PR; an empty save still verifies the push
echo "second edit" >> "$SAVE_WT/file.txt"
status=0; out=$(run_wt "$SAVE_WT" save "selftest: second save") || status=$?
if [ "$status" -ne 0 ] || ! echo "$out" | grep -q "PR: already exists"; then echo "FAIL test-11b: second save did not reuse the PR: $out"; FAILED=1; fi
[ "$(wc -l < "$GH_CREATE_LOG" | tr -d ' ')" -eq 1 ] || { echo "FAIL test-11b: a second draft PR was created"; FAILED=1; }
status=0; out=$(run_wt "$SAVE_WT" save "selftest: nothing") || status=$?
if [ "$status" -ne 0 ] || ! echo "$out" | grep -q "Nothing new to commit"; then echo "FAIL test-11b: empty save: $out"; FAILED=1; fi

# 11c. 'done' refuses unpushed commits with the actionable message; after save it reaches the merge check
(cd "$SAVE_WT" && echo "local only" >> file.txt && git commit -q -am "local only commit")
status=0; out=$(run_wt "$MOCK_LOCAL" done save-job) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "unpushed"; then
  echo "FAIL test-11c: 'done' did not refuse unpushed work (status $status): $out"; FAILED=1
fi
[ -d "$SAVE_WT" ] || { echo "FAIL test-11c: 'done' removed a worktree with unpushed work"; FAILED=1; }
run_wt "$SAVE_WT" save "selftest: push the local commit" >/dev/null
status=0; out=$(run_wt "$MOCK_LOCAL" done save-job) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "is not merged into origin/main"; then
  echo "FAIL test-11c: after the push, 'done' should reach the merge check (status $status): $out"; FAILED=1
fi

# 11d. secrets: each pattern refuses; nothing is committed or pushed; the value is never printed
BEFORE_SHA=$(git -C "$SAVE_WT" rev-parse HEAD); REMOTE_BEFORE=$(remote_sha job/save-job)
check_refused() { # check_refused <label> <file> <expected finding text>
  local label="$1" file="$2" want="$3" rstatus=0 rout
  rout=$(run_wt "$SAVE_WT" save "selftest: must be refused") || rstatus=$?
  if [ "$rstatus" -eq 0 ] || ! echo "$rout" | grep -qF "$want"; then
    echo "FAIL test-11d ($label): expected refusal mentioning '$want' (status $rstatus): $rout"; FAILED=1
  fi
  if echo "$rout" | grep -qE 'abcdefghij0123456789|BEGIN PRIVATE'; then
    echo "FAIL test-11d ($label): the secret value was printed"; FAILED=1
  fi
  if [ "$(git -C "$SAVE_WT" rev-parse HEAD)" != "$BEFORE_SHA" ] || [ "$(remote_sha job/save-job)" != "$REMOTE_BEFORE" ]; then
    echo "FAIL test-11d ($label): something was committed or pushed despite the secret"; FAILED=1
  fi
  git -C "$SAVE_WT" reset -q >/dev/null 2>&1 || true
  git -C "$SAVE_WT" clean -fq -- "$file"
}
printf 'KEY=%s\n' "$(fake_token sk)" > "$SAVE_WT/cfg-sk.txt";    check_refused "sk-"   cfg-sk.txt  "cfg-sk.txt:1: looks like a sk- API key"
printf 'x\nT=%s\n' "$(fake_token ghp)" > "$SAVE_WT/cfg-gh.txt"; check_refused "ghp_"  cfg-gh.txt  "cfg-gh.txt:2: looks like a GitHub token"
printf 'A=%s\n' "$(fake_token aws)" > "$SAVE_WT/cfg-aws.txt";    check_refused "AKIA"  cfg-aws.txt "cfg-aws.txt:1: looks like a AWS access key"
printf '%s\n' "$(fake_token pem)" > "$SAVE_WT/cfg-pem.txt";      check_refused "pem"   cfg-pem.txt "cfg-pem.txt:1: looks like a private key block"
printf 'FOO=bar\n' > "$SAVE_WT/.env";                            check_refused ".env"  .env        ".env: .env file is staged"
mkdir -p "$SAVE_WT/sub"; printf 'FOO=bar\n' > "$SAVE_WT/sub/prod.env"
check_refused "*.env" sub/prod.env "sub/prod.env: .env file is staged"
# explicit paths: the file is refused when only it is named
printf 'KEY=%s\n' "$(fake_token sk)" > "$SAVE_WT/cfg-sk2.txt"
status=0; out=$(run_wt "$SAVE_WT" save "selftest: explicit" -- cfg-sk2.txt) || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "cfg-sk2.txt:1"; then echo "FAIL test-11d: explicit path with a secret was not refused"; FAILED=1; fi
git -C "$SAVE_WT" reset -q >/dev/null 2>&1 || true
git -C "$SAVE_WT" clean -fq -- cfg-sk2.txt

# no false positives: ordinary text, a short 'sk-', and the documented .env templates pass
printf 'disk-usage and task-queue; risk-aware sk-short\n' > "$SAVE_WT/notes.txt"
printf 'FOO=\n' > "$SAVE_WT/.env.example"
status=0; out=$(run_wt "$SAVE_WT" save "selftest: clean text and .env.example") || status=$?
[ "$status" -eq 0 ] || { echo "FAIL test-11d: false positive on ordinary text or .env.example: $out"; FAILED=1; }

# 11g. explicit paths: 'save "<msg>" -- <path>' commits only that path
echo "only me" > "$SAVE_WT/only.txt"; echo "not me" > "$SAVE_WT/other.txt"
run_wt "$SAVE_WT" save "selftest: only one path" -- only.txt >/dev/null
git -C "$SAVE_WT" cat-file -e HEAD:only.txt 2>/dev/null || { echo "FAIL test-11g: the named path was not committed"; FAILED=1; }
if git -C "$SAVE_WT" cat-file -e HEAD:other.txt 2>/dev/null; then echo "FAIL test-11g: a path that was not named was committed"; FAILED=1; fi
git -C "$SAVE_WT" clean -fq -- other.txt

# 11e. hooks stay on: a pre-commit hook runs on save; a failing hook blocks commit and push
HOOK="$BASE_CLONE/.git/hooks/pre-commit"
# shebang-free like the gh stub (AGENTS_LEARNING 12.27: an interpreter launch of a temp script can stall on macOS)
printf 'echo ran >> "%s"\n[ "$(cat "%s")" = fail ] && exit 1\nexit 0\n' "$WORK/hook.log" "$WORK/hook_mode" > "$HOOK"
chmod +x "$HOOK"
echo pass > "$WORK/hook_mode"
echo "hooked" >> "$SAVE_WT/file.txt"
run_wt "$SAVE_WT" save "selftest: hook passes" >/dev/null
[ -s "$WORK/hook.log" ] || { echo "FAIL test-11e: the pre-commit hook did not run on save"; FAILED=1; }
echo fail > "$WORK/hook_mode"
echo "blocked by hook" >> "$SAVE_WT/file.txt"
BEFORE_SHA=$(git -C "$SAVE_WT" rev-parse HEAD); REMOTE_BEFORE=$(remote_sha job/save-job)
status=0; out=$(run_wt "$SAVE_WT" save "selftest: hook fails") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "commit was refused"; then
  echo "FAIL test-11e: a failing hook did not fail save (status $status): $out"; FAILED=1
fi
if [ "$(git -C "$SAVE_WT" rev-parse HEAD)" != "$BEFORE_SHA" ] || [ "$(remote_sha job/save-job)" != "$REMOTE_BEFORE" ]; then
  echo "FAIL test-11e: a hook-refused save still committed or pushed"; FAILED=1
fi
printf 'exit 0\n' > "$HOOK"
git -C "$SAVE_WT" reset -q >/dev/null 2>&1 || true
git -C "$SAVE_WT" checkout -q -- file.txt
if grep -qE -- '--no-verify|hooksPath' "$WORKTREE_SCRIPT" "$ROOT/scripts/lib/worktree-safety.sh"; then
  echo "FAIL test-11e: worktree.sh or its library mentions --no-verify or hooksPath"; FAILED=1
fi

# 11h. a push that "succeeds" but does not land on the remote we read back is reported as a failure:
#      pushes go to a different bare repo (pushurl) than the one ls-remote reads (origin's fetch url)
git init -q --bare "$WORK/elsewhere.git" >/dev/null 2>&1
git -C "$SAVE_WT" config remote.origin.pushurl "$WORK/elsewhere.git"
echo "diverted" >> "$SAVE_WT/file.txt"
status=0; out=$(run_wt "$SAVE_WT" save "selftest: push goes elsewhere") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "after the push, origin/job/save-job is"; then
  echo "FAIL test-11h: an unverifiable push was reported as success (status $status): $out"; FAILED=1
fi
git -C "$SAVE_WT" config --unset remote.origin.pushurl

# 11f. save refuses where it must not run, and fails honestly when gh is down
status=0; out=$(run_wt "$BASE_CLONE" save "selftest: base") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "protected repository"; then echo "FAIL test-11f: save ran in the base clone (status $status): $out"; FAILED=1; fi
git clone -q "$MOCK_ORIGIN" "$WORK/plain_clone" >/dev/null 2>&1
status=0; out=$(run_wt "$WORK/plain_clone" save "selftest: plain clone") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "not a linked job worktree"; then echo "FAIL test-11f: save ran in a plain clone (status $status): $out"; FAILED=1; fi
git -C "$BASE_CLONE" worktree add -q --detach "$FAKE_SCRATCH/opensand-detached-probe" origin/main >/dev/null 2>&1
status=0; out=$(run_wt "$FAKE_SCRATCH/opensand-detached-probe" save "selftest: detached") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "detached HEAD"; then echo "FAIL test-11f: save ran on a detached HEAD (status $status): $out"; FAILED=1; fi
git -C "$BASE_CLONE" worktree add -q -B main "$FAKE_SCRATCH/opensand-on-main-probe" origin/main >/dev/null 2>&1
status=0; out=$(run_wt "$FAKE_SCRATCH/opensand-on-main-probe" save "selftest: on main") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "refusing to save onto 'main'"; then echo "FAIL test-11f: save ran on main (status $status): $out"; FAILED=1; fi
status=0; out=$(run_wt "$SAVE_WT" save "") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "Usage:"; then echo "FAIL test-11f: empty message was accepted"; FAILED=1; fi
echo "gh down" >> "$SAVE_WT/file.txt"
status=0; out=$(GH_STUB_FAIL=1 run_wt "$SAVE_WT" save "selftest: gh down") || status=$?
if [ "$status" -eq 0 ] || ! echo "$out" | grep -q "could not check for an existing PR"; then
  echo "FAIL test-11f: gh failure did not fail save honestly (status $status): $out"; FAILED=1
fi
[ "$(remote_sha job/save-job)" = "$(git -C "$SAVE_WT" rev-parse HEAD)" ] || { echo "FAIL test-11f: work was not pushed before the PR step failed"; FAILED=1; }
echo "PASS test-11: save commits with hooks on, refuses secrets, pushes verified, drafts one PR; done refuses unpushed work"

if [ "$FAILED" -eq 0 ]; then
  echo "ALL WORKTREE SELFTESTS PASSED."
fi

exit "$FAILED"
