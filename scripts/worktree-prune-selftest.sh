set -euo pipefail

# Hermetic selftest for scripts/worktree-prune.sh
# Cases:
#   1. merged + clean + old worktree is removed
#   2. dirty worktree is kept
#   3. recently modified worktree is kept
#   4. unmerged worktree is kept
#   5. opensand-base is kept
#   6. branch deleted on origin after merging is removed
#   7. a folder that is not a linked worktree, and a linked worktree in TMPDIR, are kept
#   8. stale TMPDIR/opensand-* folder is removed, fresh one is kept
#   9. gh failure fails closed; CLI validation and help behave

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRUNE_SCRIPT="${OPENSAND_PRUNE_SCRIPT:-$ROOT/scripts/worktree-prune.sh}"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-worktree-prune-selftest.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

FAKE_SCRATCH="$WORK/scratch"
TEMP_ROOT="$WORK/temp"
mkdir -p "$FAKE_SCRATCH" "$TEMP_ROOT"

STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN"
cat << 'EOS' > "$STUB_BIN/gh"
if [ -n "${GH_STUB_FAIL:-}" ]; then
  echo "gh stub: simulated failure" >&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  state=""
  branch=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --state) state="$2"; shift 2 ;;
      --head) branch="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ "$state" = "merged" ] && [ -n "$branch" ] && grep -qx -- "$branch" "$GH_MERGED_PR_BRANCHES" 2>/dev/null; then
    echo 1
  else
    echo 0
  fi
  exit 0
fi
echo 0
EOS
chmod +x "$STUB_BIN/gh"
export GH_MERGED_PR_BRANCHES="$WORK/merged_branches"
: > "$GH_MERGED_PR_BRANCHES"
export PATH="$STUB_BIN:$PATH"
export GIT_AUTHOR_NAME="Selftest" GIT_AUTHOR_EMAIL="selftest@example.com"
export GIT_COMMITTER_NAME="Selftest" GIT_COMMITTER_EMAIL="selftest@example.com"

age_files() {
  find "$1" -path "$1/.git" -prune -o -exec touch -t 202001010000 {} +
}

MOCK_ORIGIN="$WORK/mock_origin.git"
git init -b main --bare "$MOCK_ORIGIN" >/dev/null 2>&1 || git init --bare "$MOCK_ORIGIN" >/dev/null
MOCK_SEED="$WORK/mock_seed"
git clone "$MOCK_ORIGIN" "$MOCK_SEED" >/dev/null 2>&1
(
  cd "$MOCK_SEED"
  git config user.name "Selftest"
  git config user.email "selftest@example.com"
  echo "initial" > file.txt
  git add file.txt
  git commit -m "initial" >/dev/null
  git branch -M main
  git push origin main >/dev/null 2>&1
)
git -C "$MOCK_ORIGIN" symbolic-ref HEAD refs/heads/main >/dev/null 2>&1 || true

BASE_CLONE="$FAKE_SCRATCH/opensand-base"
git clone "$MOCK_ORIGIN" "$BASE_CLONE" >/dev/null 2>&1
git -C "$BASE_CLONE" checkout --quiet --detach origin/main

add_wt() {
  git -C "$BASE_CLONE" worktree add -q -b "$1" "$2" origin/main >/dev/null 2>&1
}

# 1. merged + clean + old
MERGED_CLEAN="$FAKE_SCRATCH/opensand-merged-clean"
add_wt job/merged-clean "$MERGED_CLEAN"
echo "job/merged-clean" >> "$GH_MERGED_PR_BRANCHES"
git -C "$BASE_CLONE" push origin job/merged-clean >/dev/null 2>&1
age_files "$MERGED_CLEAN"

# 2. dirty (untracked file)
DIRTY="$FAKE_SCRATCH/opensand-dirty"
add_wt job/dirty "$DIRTY"
echo "job/dirty" >> "$GH_MERGED_PR_BRANCHES"
echo "untracked" > "$DIRTY/dirty.txt"
age_files "$DIRTY"

# 3. recently modified
RECENT="$FAKE_SCRATCH/opensand-recent"
add_wt job/recent "$RECENT"
echo "job/recent" >> "$GH_MERGED_PR_BRANCHES"
age_files "$RECENT"
touch "$RECENT/file.txt"

# 4. unmerged, still on origin
UNMERGED="$FAKE_SCRATCH/opensand-unmerged"
add_wt job/unmerged "$UNMERGED"
git -C "$BASE_CLONE" push origin job/unmerged >/dev/null 2>&1
age_files "$UNMERGED"

# 6. branch deleted on origin after merge: never pushed, HEAD is on origin/main
DELETED_BRANCH="$FAKE_SCRATCH/opensand-deleted-branch"
add_wt job/deleted "$DELETED_BRANCH"
age_files "$DELETED_BRANCH"

# 7a. plain folder that is not a worktree
NOT_WT="$FAKE_SCRATCH/opensand-not-a-worktree"
mkdir -p "$NOT_WT"
echo "notes" > "$NOT_WT/notes.txt"
age_files "$NOT_WT"

# 7b. a linked worktree sitting in TMPDIR must be kept
TEMP_LINKED="$TEMP_ROOT/opensand-linked-temp"
add_wt job/temp-linked "$TEMP_LINKED"
age_files "$TEMP_LINKED"

# 8. stale and fresh TMPDIR folders
STALE_TEMP="$TEMP_ROOT/opensand-stale-temp"
FRESH_TEMP="$TEMP_ROOT/opensand-fresh-temp"
mkdir -p "$STALE_TEMP" "$FRESH_TEMP"
echo "old" > "$STALE_TEMP/old.txt"
echo "new" > "$FRESH_TEMP/new.txt"
age_files "$STALE_TEMP"

run_prune() {
  OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" OPENSAND_TEMP_ROOT="$TEMP_ROOT" \
    bash "$PRUNE_SCRIPT" "$@" 2>&1
}

FAILED=0
check() {
  if [[ "$1" == "has" ]]; then
    echo "$3" | grep -qF -- "$2" || { echo "FAIL: expected output to contain '$2'"; FAILED=1; }
  else
    echo "$3" | grep -qF -- "$2" && { echo "FAIL: expected output NOT to contain '$2'"; FAILED=1; }
  fi
  return 0
}
exists() {
  [[ -d "$1" ]] || { echo "FAIL: expected $1 to exist"; FAILED=1; }
}
gone() {
  [[ ! -e "$1" ]] || { echo "FAIL: expected $1 to be gone"; FAILED=1; }
}

# --- CLI validation ---
echo "==> Testing CLI validation..."
status=0
bash "$PRUNE_SCRIPT" --invalid-arg >/dev/null 2>&1 || status=$?
[[ "$status" -eq 1 ]] || { echo "FAIL: bad argument returned $status"; FAILED=1; }
status=0
bash "$PRUNE_SCRIPT" --help >/dev/null 2>&1 || status=$?
[[ "$status" -eq 0 ]] || { echo "FAIL: --help returned $status"; FAILED=1; }
echo "PASS: CLI validation"

# --- Dry run ---
echo "==> Testing --dry-run (default)..."
dry_out=$(run_prune)
check has "DRY RUN: would remove opensand-merged-clean (merged PR on branch 'job/merged-clean'" "$dry_out"
check has "DRY RUN: would remove opensand-deleted-branch (branch 'job/deleted' deleted on origin after merge" "$dry_out"
check has "SKIP: opensand-dirty — uncommitted changes (dirty)" "$dry_out"
check has "SKIP: opensand-recent — a file changed in the last 120 minutes" "$dry_out"
check has "SKIP: opensand-unmerged — branch 'job/unmerged' is not a merged PR" "$dry_out"
check has "SKIP: opensand-base — protected path" "$dry_out"
check has "SKIP: opensand-not-a-worktree — not a linked worktree" "$dry_out"
check has "DRY RUN: would remove stale temp folder $STALE_TEMP" "$dry_out"
check has "Disk space before" "$dry_out"
check has "Disk space after" "$dry_out"
check has "dry run complete: 2 worktree(s) and 1 temp folder(s) eligible" "$dry_out"
exists "$MERGED_CLEAN"
exists "$DELETED_BRANCH"
exists "$STALE_TEMP"
echo "PASS: dry-run reported all 5 required cases and deleted nothing"

# --- Apply ---
echo "==> Testing --apply..."
apply_out=$(run_prune --apply)
check has "REMOVE: opensand-merged-clean" "$apply_out"
check has "REMOVE: opensand-deleted-branch" "$apply_out"
check has "REMOVE: stale temp folder $STALE_TEMP" "$apply_out"
gone "$MERGED_CLEAN"
gone "$DELETED_BRANCH"
gone "$STALE_TEMP"
exists "$DIRTY"
exists "$RECENT"
exists "$UNMERGED"
exists "$BASE_CLONE"
exists "$NOT_WT"
exists "$TEMP_LINKED"
exists "$FRESH_TEMP"
echo "PASS: apply removed only the two eligible worktrees and the stale temp folder"

# --- gh failure fails closed ---
echo "==> Testing gh failure (fail closed)..."
RETRY="$FAKE_SCRATCH/opensand-gh-failure"
add_wt job/gh-failure "$RETRY"
echo "job/gh-failure" >> "$GH_MERGED_PR_BRANCHES"
git -C "$BASE_CLONE" push origin job/gh-failure >/dev/null 2>&1
age_files "$RETRY"
fail_out=$(GH_STUB_FAIL=1 run_prune --apply)
check has "SKIP: opensand-gh-failure — cannot verify branch 'job/gh-failure' on GitHub/origin (fail closed)" "$fail_out"
exists "$RETRY"
echo "PASS: gh failure kept the worktree"

if [[ "$FAILED" -eq 0 ]]; then
  echo "ALL WORKTREE-PRUNE SELFTESTS PASSED."
fi
exit "$FAILED"
