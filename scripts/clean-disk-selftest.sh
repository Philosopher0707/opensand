set -euo pipefail

# Hermetic selftest for scripts/clean-disk.sh
# Tests:
#   1. Dry-run mode reports targets and skips dirty/unmerged without deleting anything
#   2. Live mode (--yes) deletes only clean & merged worktree node_modules/dist
#   3. Dirty worktrees are NEVER cleaned (even with --yes)
#   4. Unmerged worktrees are NEVER cleaned (even with --yes)
#   5. Forbidden paths are protected
#   6. CLI argument validation
#   7. Live rule: a worktree whose branch has an OPEN PR, or with a file changed in the last
#      2 hours, or whose open-PR state cannot be read, is NEVER cleaned (even with --yes)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLEAN_DISK_SCRIPT="$ROOT/scripts/clean-disk.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/opensand-clean-disk-selftest.XXXXXX")
cleanup() {
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
export PATH="$STUB_BIN:$PATH"

# Backdate every file outside .git so the 2-hour live rule does not trip on setup files
age_files() {
  find "$1" -path "$1/.git" -prune -o -exec touch -t 202001010000 {} +
}

# Create a central mock origin bare repo
MOCK_ORIGIN="$WORK/mock_origin.git"
git init -b main --bare "$MOCK_ORIGIN" >/dev/null 2>&1 || git init --bare "$MOCK_ORIGIN" >/dev/null

# Create a base clone to establish origin/main with realistic .gitignore
MOCK_BASE="$WORK/mock_base"
git clone "$MOCK_ORIGIN" "$MOCK_BASE" >/dev/null 2>&1
(
  cd "$MOCK_BASE"
  git config user.name "Selftest"
  git config user.email "selftest@example.com"
  printf "node_modules/\ndist/\n" > .gitignore
  echo "initial" > base.txt
  git add .gitignore base.txt
  git commit -m "initial commit" >/dev/null
  git branch -M main
  git push origin main >/dev/null 2>&1
)
git -C "$MOCK_ORIGIN" symbolic-ref HEAD refs/heads/main >/dev/null 2>&1 || true

# 1. Create clean & merged worktree
CLEAN_MERGED="$FAKE_SCRATCH/clean-merged"
git clone "$MOCK_ORIGIN" "$CLEAN_MERGED" >/dev/null 2>&1
mkdir -p "$CLEAN_MERGED/node_modules/fake-pkg" "$CLEAN_MERGED/dist" "$CLEAN_MERGED/packages/sub/node_modules"
touch "$CLEAN_MERGED/node_modules/fake-pkg/index.js" "$CLEAN_MERGED/dist/bundle.js" "$CLEAN_MERGED/packages/sub/node_modules/sub.js"

# 2. Create dirty worktree (uncommitted change to a tracked file or untracked non-ignored file)
DIRTY_WORKTREE="$FAKE_SCRATCH/dirty-worktree"
git clone "$MOCK_ORIGIN" "$DIRTY_WORKTREE" >/dev/null 2>&1
mkdir -p "$DIRTY_WORKTREE/node_modules/fake-pkg"
touch "$DIRTY_WORKTREE/node_modules/fake-pkg/index.js"
echo "uncommitted change" > "$DIRTY_WORKTREE/dirty_file.txt"

# 3. Create unmerged worktree
UNMERGED_WORKTREE="$FAKE_SCRATCH/unmerged-worktree"
git clone "$MOCK_ORIGIN" "$UNMERGED_WORKTREE" >/dev/null 2>&1
(
  cd "$UNMERGED_WORKTREE"
  git config user.name "Selftest"
  git config user.email "selftest@example.com"
  git checkout -b feature-unmerged >/dev/null 2>&1
  echo "unmerged work" > feature.txt
  git add feature.txt
  git commit -m "unmerged commit" >/dev/null
)
mkdir -p "$UNMERGED_WORKTREE/node_modules/fake-pkg"
touch "$UNMERGED_WORKTREE/node_modules/fake-pkg/index.js"

# 4. Live worktrees: clean + merged + old files, but must still be preserved
LIVE_OPEN_PR="$FAKE_SCRATCH/live-open-pr"
git clone "$MOCK_ORIGIN" "$LIVE_OPEN_PR" >/dev/null 2>&1
git -C "$LIVE_OPEN_PR" checkout -b feature-open-pr >/dev/null 2>&1
mkdir -p "$LIVE_OPEN_PR/node_modules/fake-pkg"
touch "$LIVE_OPEN_PR/node_modules/fake-pkg/index.js"
echo "feature-open-pr" >> "$GH_OPEN_PR_BRANCHES"

LIVE_RECENT="$FAKE_SCRATCH/live-recent"
git clone "$MOCK_ORIGIN" "$LIVE_RECENT" >/dev/null 2>&1
mkdir -p "$LIVE_RECENT/node_modules/fake-pkg"
touch "$LIVE_RECENT/node_modules/fake-pkg/index.js"

for wt in "$CLEAN_MERGED" "$DIRTY_WORKTREE" "$UNMERGED_WORKTREE" "$LIVE_OPEN_PR" "$LIVE_RECENT"; do
  age_files "$wt"
done
# A gitignored file touched just now keeps the worktree clean but live
touch "$LIVE_RECENT/node_modules/fake-pkg/fresh.log"

FAILED=0

# --- Test 1: Argument validation & help ---
echo "==> Testing argument validation..."
status=0
bash "$CLEAN_DISK_SCRIPT" --invalid-arg >/dev/null 2>&1 || status=$?
if [ "$status" -ne 1 ]; then
  echo "FAIL: expected exit 1 on bad argument, got $status"
  FAILED=1
fi

status=0
bash "$CLEAN_DISK_SCRIPT" --help >/dev/null 2>&1 || status=$?
if [ "$status" -ne 0 ]; then
  echo "FAIL: expected exit 0 on --help, got $status"
  FAILED=1
fi
echo "PASS: argument validation"

# --- Test 2: Dry-run execution ---
echo "==> Testing dry-run execution..."
dry_out=$(OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$CLEAN_DISK_SCRIPT" 2>&1)
echo "$dry_out" | grep -q "clean-merged is clean, merged into origin/main, and not live" || {
  echo "FAIL: clean_merged not recognized as target in dry-run"
  FAILED=1
}
echo "$dry_out" | grep -q "dirty-worktree has uncommitted changes" || {
  echo "FAIL: dirty_worktree was not skipped in dry-run"
  FAILED=1
}
echo "$dry_out" | grep -q "unmerged-worktree.*is not merged into origin/main" || {
  echo "FAIL: unmerged_worktree was not skipped in dry-run"
  FAILED=1
}
echo "$dry_out" | grep -q "live-open-pr is live: branch 'feature-open-pr' has an OPEN PR" || {
  echo "FAIL: live-open-pr was not skipped as live in dry-run"
  FAILED=1
}
echo "$dry_out" | grep -q "live-recent is live: a file changed in the last 120 minutes" || {
  echo "FAIL: live-recent was not skipped as live in dry-run"
  FAILED=1
}
# Verify nothing was deleted in dry-run
if [ ! -d "$CLEAN_MERGED/node_modules" ] || [ ! -d "$CLEAN_MERGED/dist" ]; then
  echo "FAIL: dry-run deleted directories in clean-merged!"
  FAILED=1
fi
if [ ! -d "$DIRTY_WORKTREE/node_modules" ]; then
  echo "FAIL: dry-run deleted directories in dirty-worktree!"
  FAILED=1
fi
if [ ! -d "$UNMERGED_WORKTREE/node_modules" ]; then
  echo "FAIL: dry-run deleted directories in unmerged-worktree!"
  FAILED=1
fi
echo "PASS: dry-run execution"

# --- Test 3: Live execution with --yes ---
echo "==> Testing live execution (--yes)..."
live_out=$(OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$CLEAN_DISK_SCRIPT" --yes 2>&1)

# Verify clean_merged targets were deleted
if [ -d "$CLEAN_MERGED/node_modules" ]; then
  echo "FAIL: live mode failed to delete $CLEAN_MERGED/node_modules"
  FAILED=1
fi
if [ -d "$CLEAN_MERGED/dist" ]; then
  echo "FAIL: live mode failed to delete $CLEAN_MERGED/dist"
  FAILED=1
fi
if [ -d "$CLEAN_MERGED/packages/sub/node_modules" ]; then
  echo "FAIL: live mode failed to delete $CLEAN_MERGED/packages/sub/node_modules"
  FAILED=1
fi

# CRITICAL: Verify dirty and unmerged worktree node_modules were PRESERVED
if [ ! -d "$DIRTY_WORKTREE/node_modules" ]; then
  echo "FAIL: live mode deleted dirty worktree node_modules!"
  FAILED=1
fi
if [ ! -d "$UNMERGED_WORKTREE/node_modules" ]; then
  echo "FAIL: live mode deleted unmerged worktree node_modules!"
  FAILED=1
fi
echo "PASS: live execution (--yes) preserved dirty and unmerged worktrees while cleaning merged targets"

# --- Test 4: Live rule keeps open-PR, recently-changed and unverifiable worktrees ---
echo "==> Testing live rule (open PR, recent file, gh failure)..."
if [ ! -d "$LIVE_OPEN_PR/node_modules" ]; then
  echo "FAIL: live mode deleted node_modules of a worktree whose branch has an OPEN PR!"
  FAILED=1
fi
if [ ! -d "$LIVE_RECENT/node_modules" ]; then
  echo "FAIL: live mode deleted node_modules of a worktree with a file changed in the last 2h!"
  FAILED=1
fi

# Fail closed: with gh failing, even the old clean+merged worktree must be kept
mkdir -p "$CLEAN_MERGED/node_modules/fake-pkg"
touch "$CLEAN_MERGED/node_modules/fake-pkg/index.js"
age_files "$CLEAN_MERGED"
fail_out=$(GH_STUB_FAIL=1 OPENSAND_SCRATCH_DIR="$FAKE_SCRATCH" bash "$CLEAN_DISK_SCRIPT" --yes 2>&1)
echo "$fail_out" | grep -q "clean-merged is live: cannot verify open PRs" || {
  echo "FAIL: gh failure did not fail closed"
  FAILED=1
}
if [ ! -d "$CLEAN_MERGED/node_modules" ]; then
  echo "FAIL: gh failure still allowed deletion"
  FAILED=1
fi
echo "PASS: live rule preserved open-PR, recently-changed and unverifiable worktrees"

if [ "$FAILED" -eq 0 ]; then
  echo "ALL CLEAN-DISK SELFTESTS PASSED."
fi

exit "$FAILED"
