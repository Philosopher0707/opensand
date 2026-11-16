#!/usr/bin/env bash
# OpenSand disk cleanup utility
# Usage:
#   scripts/clean-disk.sh [--yes]
#
# Safe reclaim:
#   - Deletes ONLY node_modules and dist in ~/dev/_scratch/*
#     that are clean (no uncommitted changes), merged into origin/main, and not live
#     (no OPEN PR on the branch, no file changed in the last 2 hours).
#   - Prunes pnpm store and npm/Electron cache directories.
#   - Defaults to dry-run; requires --yes to delete.
#   - Displays df -h before and after.
#   - NEVER touches ~/dev/opensand, ~/.opensand, or /Applications/OpenSand.app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Source shared safety helper
source "$ROOT/scripts/lib/worktree-safety.sh"

SCRATCH_DIR="${OPENSAND_SCRATCH_DIR:-$HOME/dev/_scratch}"

YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      YES=1
      shift
      ;;
    -h|--help)
      echo "Usage: scripts/clean-disk.sh [--yes]"
      echo "Options:"
      echo "  --yes    Execute deletions (default is dry-run)"
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument '$1'" >&2
      echo "Usage: scripts/clean-disk.sh [--yes]" >&2
      exit 1
      ;;
  esac
done

echo "==> [clean-disk] Disk space before cleanup:"
df -h /

if [[ "$YES" -eq 1 ]]; then
  echo "==> [clean-disk] Running in LIVE mode (--yes passed)..."
else
  echo "==> [clean-disk] Running in DRY-RUN mode (pass --yes to delete)..."
fi

# 1. Clean scratch worktrees
echo "==> [clean-disk] Inspecting scratch worktrees in $SCRATCH_DIR..."
if [[ -d "$SCRATCH_DIR" ]]; then
  for dir in "$SCRATCH_DIR"/*; do
    [[ -d "$dir" ]] || continue

    # Check forbidden paths
    if is_forbidden_worktree_path "$dir"; then
      echo "SKIP: $dir matches forbidden path"
      continue
    fi

    # Check git repo status
    if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "SKIP: $dir is not a git worktree"
      continue
    fi

    # Check for uncommitted changes (dirty guard)
    if is_worktree_dirty "$dir"; then
      echo "SKIP: $dir has uncommitted changes (dirty)"
      continue
    fi

    # Check if HEAD is merged into origin/main
    if ! is_worktree_merged "$dir" "$ROOT"; then
      HEAD_SHA=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo "unknown")
      echo "SKIP: $dir (commit $HEAD_SHA) is not merged into origin/main"
      continue
    fi

    # Live rule: open PR on the branch, or any file changed in the last 2 hours
    if is_worktree_live "$dir"; then
      echo "SKIP: $dir is live: $LIVE_REASON"
      continue
    fi

    echo "TARGET: $dir is clean, merged into origin/main, and not live"
    # Find candidates
    CANDIDATES=()
    for pattern in "node_modules" "dist" "packages/*/node_modules" "packages/*/dist"; do
      for target in "$dir"/$pattern; do
        if [[ -e "$target" ]]; then
          CANDIDATES+=("$target")
        fi
      done
    done

    if [[ ${#CANDIDATES[@]} -eq 0 ]]; then
      echo "  No node_modules or dist found in $dir"
    else
      for cand in "${CANDIDATES[@]}"; do
        if [[ "$YES" -eq 1 ]]; then
          echo "  Deleting: $cand"
          rm -rf "$cand"
        else
          echo "  DRY RUN: would delete $cand"
        fi
      done
    fi
  done
else
  echo "Notice: scratch directory $SCRATCH_DIR does not exist."
fi

# 2. Clean pnpm store
echo "==> [clean-disk] Checking pnpm store..."
if command -v pnpm >/dev/null 2>&1; then
  if [[ "$YES" -eq 1 ]]; then
    echo "  Running 'pnpm store prune'..."
    pnpm store prune 2>/dev/null || true
  else
    echo "  DRY RUN: would run 'pnpm store prune'"
  fi
else
  echo "  pnpm command not found, skipping."
fi

# 3. Clean npm cache
echo "==> [clean-disk] Checking npm cache..."
NPM_CACHE_DIR="$HOME/.npm/_cacache"
if [[ -d "$NPM_CACHE_DIR" ]]; then
  if [[ "$YES" -eq 1 ]]; then
    echo "  Running 'npm cache clean --force'..."
    npm cache clean --force 2>/dev/null || true
  else
    echo "  DRY RUN: would run 'npm cache clean --force'"
  fi
else
  echo "  npm cache directory not found or empty."
fi

# 4. Clean Electron caches
echo "==> [clean-disk] Checking Electron caches..."
for electron_cache in "$HOME/Library/Caches/electron" "$HOME/Library/Caches/electron-builder"; do
  if [[ -d "$electron_cache" ]]; then
    if [[ "$YES" -eq 1 ]]; then
      echo "  Deleting: $electron_cache"
      rm -rf "$electron_cache"
    else
      echo "  DRY RUN: would delete $electron_cache"
    fi
  fi
done

echo "==> [clean-disk] Disk space after cleanup:"
df -h /

echo "==> [clean-disk] Done."
exit 0
