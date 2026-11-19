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
#   - Reports free space for the writable data volume (/System/Volumes/Data on macOS,
#     $HOME on Linux CI) with df -k, never the read-only system snapshot (/dev/disk3s1s1).
#   - Prints a per-target du -sk estimate of what would be freed.
#   - NEVER touches ~/dev/opensand, ~/.opensand, or /Applications/OpenSand.app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Source shared safety helper
source "$ROOT/scripts/lib/worktree-safety.sh"

SCRATCH_DIR="${OPENSAND_SCRATCH_DIR:-$HOME/dev/_scratch}"

# Measure the writable data volume, not the read-only system snapshot (/dev/disk3s1s1).
# Same mount as scripts/status-report.sh. Linux CI has no /System/Volumes/Data: fall back to $HOME.
if [[ -d /System/Volumes/Data ]]; then
  DISK_PATH="/System/Volumes/Data"
else
  DISK_PATH="$HOME"
fi

# Hard 300s timeout for commands that can hang (du, rm, pnpm, npm):
# SIGALRM kills the child and exits 124.
with_timeout() {
  python3 - "$@" <<'PY'
import signal, subprocess, sys
proc = subprocess.Popen(sys.argv[1:])
def on_alarm(_signum, _frame):
    proc.kill()
    proc.wait()
    sys.exit(124)
signal.signal(signal.SIGALRM, on_alarm)
signal.alarm(300)
try:
    code = proc.wait()
except Exception:
    proc.kill()
    code = proc.wait()
sys.exit(code)
PY
}

disk_report() {
  echo "==> [clean-disk] $1 (volume: $DISK_PATH):"
  df -k "$DISK_PATH" 2>/dev/null || true
  df -k "$DISK_PATH" 2>/dev/null | awk -v vol="$DISK_PATH" \
    'NR==2 {printf "==> [clean-disk] %s (%s): %d KB used, %d KB available (%.2f GiB free)\n", $1, vol, $3, $4, $4/1048576}' || true
}

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

disk_report "Disk space before cleanup"

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
        EST_KB=$(with_timeout du -sk "$cand" 2>/dev/null | awk '{print $1}') || EST_KB="?"
        if [[ "$YES" -eq 1 ]]; then
          echo "  Deleting: $cand (${EST_KB} KB per du -sk)"
          with_timeout rm -rf "$cand" || true
        else
          echo "  DRY RUN: would delete $cand (${EST_KB} KB per du -sk)"
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
    with_timeout pnpm store prune 2>/dev/null || true
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
    with_timeout npm cache clean --force 2>/dev/null || true
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
      with_timeout rm -rf "$electron_cache"
    else
      echo "  DRY RUN: would delete $electron_cache"
    fi
  fi
done

disk_report "Disk space after cleanup"

echo "==> [clean-disk] Done."
exit 0
