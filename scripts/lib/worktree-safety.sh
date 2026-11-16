# OpenSand worktree safety predicates
# Shared between scripts/worktree.sh and scripts/clean-disk.sh
#
# Rules:
#   - Strictly forbids touching ~/dev/opensand, ~/.opensand, /Applications/OpenSand.app
#   - Checks for git worktree presence
#   - Checks for dirty uncommitted changes (git status --porcelain)
#   - Checks if HEAD is merged into origin/main (git merge-base --is-ancestor HEAD origin/main)

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
