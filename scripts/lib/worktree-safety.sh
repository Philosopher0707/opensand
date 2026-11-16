# OpenSand worktree safety predicates
# Shared between scripts/worktree.sh and scripts/clean-disk.sh
#
# Rules:
#   - Strictly forbids touching ~/dev/opensand, ~/.opensand, /Applications/OpenSand.app
#   - Checks for git worktree presence
#   - Checks for dirty uncommitted changes (git status --porcelain)
#   - Checks if HEAD is merged into origin/main (git merge-base --is-ancestor HEAD origin/main)
#   - Live rule: a worktree is never pruned or cleaned while its branch has an OPEN PR or any
#     file in it changed in the last 2 hours (OPENSAND_LIVE_WINDOW_MIN, default 120).
#     If the open-PR state cannot be read (gh missing or failing) the worktree counts as live.

is_forbidden_worktree_path() {
  local target_dir="$1"
  local forbidden_paths=(
    "$HOME/dev/opensand"
    "$HOME/.opensand"
    "/Applications/OpenSand.app"
  )
  for forbidden in "${forbidden_paths[@]}"; do
    if [[ "$target_dir" == "$forbidden" || "$target_dir" == "$forbidden"/* ]]; then
      return 0
    fi
  done
  return 1
}

is_worktree_dirty() {
  local target_dir="$1"
  local dirty_output
  dirty_output=$(git -C "$target_dir" status --porcelain 2>/dev/null || true)
  if [[ -n "$dirty_output" ]]; then
    return 0 # is dirty
  fi
  return 1 # is clean
}

is_worktree_merged() {
  local target_dir="$1"
  local root_ref="${2:-}"
  local head_sha

  head_sha=$(git -C "$target_dir" rev-parse HEAD 2>/dev/null || true)
  if [[ -z "$head_sha" ]]; then
    return 1 # cannot determine head -> fail closed
  fi

  # Check against origin/main directly in the worktree
  if git -C "$target_dir" merge-base --is-ancestor "$head_sha" origin/main 2>/dev/null; then
    return 0
  fi

  # Check against origin/main via provided reference repo if worktree origin is unconfigured
  if [[ -n "$root_ref" ]] && git -C "$root_ref" merge-base --is-ancestor "$head_sha" origin/main 2>/dev/null; then
    return 0
  fi

  return 1
}

# is_worktree_live <worktree_dir>
# Returns 0 (live) with the reason in LIVE_REASON; returns 1 when nothing says the worktree is in use.
is_worktree_live() {
  local target_dir="$1"
  local window="${OPENSAND_LIVE_WINDOW_MIN:-120}"
  local branch open_prs recent
  LIVE_REASON=""

  branch=$(git -C "$target_dir" symbolic-ref --short HEAD 2>/dev/null || true)
  if [[ -n "$branch" ]]; then
    if ! open_prs=$(cd "$target_dir" && gh pr list --head "$branch" --state open --json number --jq 'length' 2>/dev/null); then
      LIVE_REASON="cannot verify open PRs for branch '$branch' (gh failed or is missing)"
      return 0
    fi
    if [[ "$open_prs" =~ ^[0-9]+$ && "$open_prs" -gt 0 ]]; then
      LIVE_REASON="branch '$branch' has an OPEN PR"
      return 0
    fi
  fi

  recent=$(find "$target_dir" -path "$target_dir/.git" -prune -o -type f -mmin "-$window" -print -quit 2>/dev/null || true)
  if [[ -n "$recent" ]]; then
    LIVE_REASON="a file changed in the last ${window} minutes (${recent#"$target_dir"/})"
    return 0
  fi

  return 1
}

# check_worktree_safe_to_prune <worktree_dir> [root_repo_dir]
# check_worktree_safe_to_remove plus the live rule. Used by worktree.sh prune and clean-disk.sh.
check_worktree_safe_to_prune() {
  local target_dir="$1"
  local root_ref="${2:-}"

  check_worktree_safe_to_remove "$target_dir" "$root_ref" || return 1

  if is_worktree_live "$target_dir"; then
    echo "Refusing: $target_dir is live: $LIVE_REASON." >&2
    return 1
  fi

  return 0
}

# check_worktree_safe_to_remove <worktree_dir> [root_repo_dir]
# Returns 0 if safe to delete/prune; returns 1 (with explanation on stderr) if not.
check_worktree_safe_to_remove() {
  local target_dir="$1"
  local root_ref="${2:-}"

  if is_forbidden_worktree_path "$target_dir"; then
    echo "Refusing: $target_dir is a protected repository or application path." >&2
    return 1
  fi

  if ! git -C "$target_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Refusing: $target_dir is not a valid git worktree." >&2
    return 1
  fi

  if is_worktree_dirty "$target_dir"; then
    echo "Refusing: $target_dir has uncommitted changes (dirty)." >&2
    return 1
  fi

  if ! is_worktree_merged "$target_dir" "$root_ref"; then
    local head_sha
    head_sha=$(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    echo "Refusing: $target_dir (commit $head_sha) is not merged into origin/main." >&2
    return 1
  fi

  return 0
}
