#!/usr/bin/env bash
# OpenSand worktree prune: reclaim disk from eligible scratch worktrees and stale temp folders.
# Usage:
#   scripts/worktree-prune.sh [--dry-run|--apply]
#
# A worktree under $OPENSAND_SCRATCH_DIR/opensand-* is removed only if ALL hold:
#   (a) its branch is a merged PR (gh pr list --state merged), or the branch was deleted on
#       origin after merging;
#   (b) git status --porcelain is empty (clean);
#   (c) no file outside .git changed in the last 2 hours (OPENSAND_PRUNE_WINDOW_MIN).
# Never touches opensand-base, ~/dev/opensand, a primary clone, or a folder that is not a linked worktree.
# Also removes $TMPDIR/opensand-* folders older than 1 day (OPENSAND_TEMP_ROOT overrides the root).
# Dry-run is the default; --apply performs the removals. Free space is reported before and after
# on the writable data volume, never the read-only system snapshot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source "$ROOT/scripts/lib/worktree-safety.sh"
source "$ROOT/scripts/lib/free-space.sh"

SCRATCH_DIR="${OPENSAND_SCRATCH_DIR:-$HOME/dev/_scratch}"
TEMP_ROOT="${OPENSAND_TEMP_ROOT:-${TMPDIR:-/tmp}}"
WINDOW_MIN="${OPENSAND_PRUNE_WINDOW_MIN:-120}"
TEMP_WINDOW_MIN="${OPENSAND_TEMP_WINDOW_MIN:-1440}"

MODE="dry-run"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      MODE="apply"
      shift
      ;;
    --dry-run)
      MODE="dry-run"
      shift
      ;;
    -h|--help)
      echo "Usage: scripts/worktree-prune.sh [--dry-run|--apply]"
      echo "  --dry-run  report candidates, delete nothing (default)"
      echo "  --apply    remove eligible worktrees and stale temp folders"
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument '$1'" >&2
      echo "Usage: scripts/worktree-prune.sh [--dry-run|--apply]" >&2
      exit 1
      ;;
  esac
done

disk_report() {
  echo "==> [worktree-prune] $1 (volume: $DISK_PATH):"
  df -k "$DISK_PATH" 2>/dev/null || true
  df -k "$DISK_PATH" 2>/dev/null | awk -v vol="$DISK_PATH" \
    'NR==2 {printf "==> [worktree-prune] %s (%s): %d KB used, %d KB available (%.2f GiB free)\n", $1, vol, $3, $4, $4/1048576}' || true
}

# A linked worktree has a .git *file* pointing at the owning repository's common dir; a primary
# clone has a .git directory. This refuses plain clones and non-repository folders alike.
is_linked_worktree() {
  local dir="$1" common
  [[ -f "$dir/.git" ]] || return 1
  common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  [[ -n "$common" && "$common" != "$dir/.git" ]]
}

is_recent() {
  local dir="$1" window="$2" recent
  recent=$(find "$dir" -path "$dir/.git" -prune -o -type f -mmin "-$window" -print -quit 2>/dev/null || true)
  [[ -n "$recent" ]]
}

is_merged_into_main() {
  git -C "$1" merge-base --is-ancestor HEAD origin/main 2>/dev/null
}

# 0 = merged PR found, 2 = gh could not be read, 1 = no merged PR.
merged_pr_state() {
  local dir="$1" branch="$2" count
  [[ -n "$branch" ]] || return 1
  if ! count=$(cd "$dir" && gh pr list --head "$branch" --state merged --json number --jq 'length' 2>/dev/null); then
    return 2
  fi
  if [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]]; then
    MERGE_REASON="merged PR on branch '$branch'"
    return 0
  fi
  return 1
}

# 0 = branch gone from origin and HEAD merged, 2 = remote could not be read, 1 = still present/unmerged.
branch_deleted_after_merge() {
  local dir="$1" branch="$2" rc
  [[ -n "$branch" ]] || return 1
  git -C "$dir" ls-remote --exit-code --heads origin "refs/heads/$branch" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    return 1
  fi
  if [[ "$rc" -ne 2 ]]; then
    return 2
  fi
  if is_merged_into_main "$dir"; then
    MERGE_REASON="branch '$branch' deleted on origin after merge"
    return 0
  fi
  return 1
}

# Sets MERGE_REASON / SKIP_REASON; 0 = eligible for pruning.
worktree_eligibility() {
  local dir="$1" branch state
  MERGE_REASON=""
  SKIP_REASON=""

  if is_forbidden_worktree_path "$dir"; then
    SKIP_REASON="protected path"
    return 1
  fi
  if [[ "$(pwd -P)" == "$dir" || "$(pwd -P)" == "$dir"/* ]]; then
    SKIP_REASON="current worktree"
    return 1
  fi
  if ! is_linked_worktree "$dir"; then
    SKIP_REASON="not a linked worktree"
    return 1
  fi
  branch=$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || true)
  if is_worktree_dirty "$dir"; then
    SKIP_REASON="uncommitted changes (dirty)"
    return 1
  fi
  if is_recent "$dir" "$WINDOW_MIN"; then
    SKIP_REASON="a file changed in the last ${WINDOW_MIN} minutes"
    return 1
  fi

  GH_STATE=0
  merged_pr_state "$dir" "$branch"
  state=$?
  GH_STATE=$state
  if [[ "$state" -eq 0 ]]; then
    return 0
  fi
  branch_deleted_after_merge "$dir" "$branch"
  state=$?
  if [[ "$state" -eq 0 ]]; then
    return 0
  fi
  if [[ "$state" -eq 2 || "$GH_STATE" -eq 2 ]]; then
    SKIP_REASON="cannot verify branch '$branch' on GitHub/origin (fail closed)"
  else
    SKIP_REASON="branch '$branch' is not a merged PR"
  fi
  return 1
}

echo "==> [worktree-prune] mode=$MODE scratch=$SCRATCH_DIR temp=$TEMP_ROOT"
disk_report "Disk space before"

PRUNED=0
if [[ -d "$SCRATCH_DIR" ]]; then
  for dir in "$SCRATCH_DIR"/opensand-*; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    if worktree_eligibility "$dir"; then
      if [[ "$MODE" == "apply" ]]; then
        echo "REMOVE: $name ($MERGE_REASON, clean, unchanged for ${WINDOW_MIN}m)"
        remove_worktree "$dir"
      else
        echo "DRY RUN: would remove $name ($MERGE_REASON, clean, unchanged for ${WINDOW_MIN}m)"
      fi
      PRUNED=$((PRUNED + 1))
    else
      echo "SKIP: $name — $SKIP_REASON"
    fi
  done
fi

TMP_PRUNED=0
if [[ -d "$TEMP_ROOT" ]]; then
  echo "==> [worktree-prune] Stale temp folders in $TEMP_ROOT (older than ${TEMP_WINDOW_MIN} minutes):"
  while IFS= read -r -d '' dir; do
    if is_forbidden_worktree_path "$dir" || is_linked_worktree "$dir"; then
      echo "SKIP: $dir — protected path or linked worktree"
      continue
    fi
    if [[ "$MODE" == "apply" ]]; then
      echo "REMOVE: stale temp folder $dir"
      rm -rf "$dir" || true
    else
      echo "DRY RUN: would remove stale temp folder $dir"
    fi
    TMP_PRUNED=$((TMP_PRUNED + 1))
  done < <(find "$TEMP_ROOT" -maxdepth 1 -mindepth 1 -type d -name 'opensand-*' -mmin "+$TEMP_WINDOW_MIN" -print0 2>/dev/null || true)
fi

disk_report "Disk space after"
if [[ "$MODE" == "apply" ]]; then
  echo "==> [worktree-prune] apply complete: removed $PRUNED worktree(s) and $TMP_PRUNED temp folder(s)."
else
  echo "==> [worktree-prune] dry run complete: $PRUNED worktree(s) and $TMP_PRUNED temp folder(s) eligible."
fi
exit 0
