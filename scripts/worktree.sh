#!/usr/bin/env bash
# OpenSand automated worktree lifecycle manager
# Usage:
#   scripts/worktree.sh new <job-name> [--branch <b>]
#   scripts/worktree.sh review <PR>
#   scripts/worktree.sh done <job-name>
#   scripts/worktree.sh list
#   scripts/worktree.sh prune [--dry-run|--yes]
set -euo pipefail

# Resolve script root (can be called from any clone or directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source shared safety predicates
source "$SCRIPT_DIR/lib/worktree-safety.sh"

SCRATCH_DIR="${OPENSAND_SCRATCH_DIR:-$HOME/dev/_scratch}"
CLEAN_DISK_SCRIPT="${OPENSAND_CLEAN_DISK_SCRIPT:-$SCRIPT_DIR/clean-disk.sh}"

# Guard: Refuse to run if current working directory is inside ~/dev/opensand itself
REAL_CWD="$(pwd -P)"
FORBIDDEN_MAIN="$(cd "$HOME/dev/opensand" 2>/dev/null && pwd -P || echo "$HOME/dev/opensand")"
if [[ "$REAL_CWD" == "$FORBIDDEN_MAIN" || "$REAL_CWD" == "$FORBIDDEN_MAIN"/* ]]; then
  echo "FAIL: Refusing to run worktree commands inside main repo $FORBIDDEN_MAIN." >&2
  echo "      Work must be conducted in isolated scratch worktrees under $SCRATCH_DIR." >&2
  exit 1
fi

# Ensure git commands find a valid repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    GIT_EXEC=(git -C "$ROOT")
  else
    echo "FAIL: Cannot locate a valid git repository for OpenSand." >&2
    exit 1
  fi
else
  GIT_EXEC=(git)
fi

cmd="${1:-}"
shift || true

case "$cmd" in
  new)
    JOB_NAME=""
    CUSTOM_BRANCH=""

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --branch)
          CUSTOM_BRANCH="$2"
          shift 2
          ;;
        -*)
          echo "FAIL: unknown option '$1'" >&2
          exit 1
          ;;
        *)
          if [[ -z "$JOB_NAME" ]]; then
            JOB_NAME="$1"
            shift
          else
            echo "FAIL: unexpected argument '$1'" >&2
            exit 1
          fi
          ;;
      esac
    done

    if [[ -z "$JOB_NAME" ]]; then
      echo "Usage: scripts/worktree.sh new <job-name> [--branch <b>]" >&2
      exit 1
    fi

    TARGET_PATH="$SCRATCH_DIR/opensand-$JOB_NAME"
    TARGET_BRANCH="${CUSTOM_BRANCH:-job/$JOB_NAME}"

    # 1. Refuse if path already exists
    if [[ -e "$TARGET_PATH" ]]; then
      echo "FAIL: worktree path already exists: $TARGET_PATH" >&2
      exit 1
    fi

    # 2. Refuse if branch already exists locally or on remote
    if "${GIT_EXEC[@]}" show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
      echo "FAIL: branch '$TARGET_BRANCH' already exists locally." >&2
      exit 1
    fi
    if "${GIT_EXEC[@]}" show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
      echo "FAIL: branch '$TARGET_BRANCH' already exists on remote origin." >&2
      exit 1
    fi

    # 3. Check free disk space (< 3 GB check after attempting clean-disk.sh --yes)
    AVAIL_GB=$(df -k / 2>/dev/null | awk 'NR==2 {print int($4 / 1024 / 1024)}' || echo "10")
    if [[ "$AVAIL_GB" -lt 3 ]]; then
      echo "Notice: free disk is under 3 GB (${AVAIL_GB} GB available). Attempting clean-disk.sh --yes..."
      if [[ -f "$CLEAN_DISK_SCRIPT" ]]; then
        bash "$CLEAN_DISK_SCRIPT" --yes || true
      fi
      AVAIL_GB=$(df -k / 2>/dev/null | awk 'NR==2 {print int($4 / 1024 / 1024)}' || echo "10")
      if [[ "$AVAIL_GB" -lt 3 ]]; then
        echo "FAIL: Insufficient disk space: ${AVAIL_GB} GB available (< 3 GB required)." >&2
        exit 1
      fi
    fi

    # 4. Fetch origin to ensure latest origin/main
    "${GIT_EXEC[@]}" fetch origin main >/dev/null 2>&1 || true

    ORIGIN_MAIN_SHA=$("${GIT_EXEC[@]}" rev-parse origin/main 2>/dev/null || echo "")
    if [[ -z "$ORIGIN_MAIN_SHA" ]]; then
      echo "FAIL: could not determine origin/main SHA." >&2
      exit 1
    fi

    # 5. Create worktree
    mkdir -p "$SCRATCH_DIR"
    "${GIT_EXEC[@]}" worktree add -b "$TARGET_BRANCH" "$TARGET_PATH" origin/main >/dev/null

    BASE_SHA=$(git -C "$TARGET_PATH" rev-parse HEAD)
    echo "Created worktree at: $TARGET_PATH"
    echo "Branch: $TARGET_BRANCH"
    echo "Base SHA: $BASE_SHA"
    exit 0
    ;;

  review)
    PR_ARG="${1:-}"
    if [[ -z "$PR_ARG" ]]; then
      echo "Usage: scripts/worktree.sh review <PR>" >&2
      exit 1
    fi

    PR_NUM="${PR_ARG#\#}"
    TARGET_PATH="$SCRATCH_DIR/opensand-review-pr$PR_NUM"

    echo "==> Preparing review worktree for PR #$PR_NUM..."

    # Fetch the PR head commit ref
    "${GIT_EXEC[@]}" fetch origin "pull/$PR_NUM/head:refs/remotes/origin/pr/$PR_NUM" >/dev/null 2>&1 || \
    "${GIT_EXEC[@]}" fetch origin "refs/pull/$PR_NUM/head" >/dev/null 2>&1 || true

    PR_HEAD_SHA=$("${GIT_EXEC[@]}" rev-parse "origin/pr/$PR_NUM" 2>/dev/null || "${GIT_EXEC[@]}" rev-parse "FETCH_HEAD" 2>/dev/null || true)
    if [[ -z "$PR_HEAD_SHA" ]]; then
      # Fallback to gh pr view
      PR_HEAD_SHA=$(gh pr view "$PR_NUM" --json headRefOid -q '.headRefOid' 2>/dev/null || true)
      if [[ -n "$PR_HEAD_SHA" ]]; then
        "${GIT_EXEC[@]}" fetch origin "$PR_HEAD_SHA" >/dev/null 2>&1 || true
      fi
    fi

    if [[ -z "$PR_HEAD_SHA" ]]; then
      echo "FAIL: could not fetch PR #$PR_NUM head commit." >&2
      exit 1
    fi

    # If already exists, refresh it
    if [[ -d "$TARGET_PATH" ]]; then
      echo "Refreshing existing review worktree at $TARGET_PATH..."
      "${GIT_EXEC[@]}" worktree remove --force "$TARGET_PATH" >/dev/null 2>&1 || rm -rf "$TARGET_PATH"
      "${GIT_EXEC[@]}" worktree prune >/dev/null 2>&1 || true
    fi

    mkdir -p "$SCRATCH_DIR"
    "${GIT_EXEC[@]}" worktree add --detach "$TARGET_PATH" "$PR_HEAD_SHA" >/dev/null

    # Mark worktree read-only for safe inspection
    chmod -R a-w "$TARGET_PATH" 2>/dev/null || true
    # Keep .git writable if git metadata needs it
    if [[ -d "$TARGET_PATH/.git" ]]; then
      chmod -R u+w "$TARGET_PATH/.git" 2>/dev/null || true
    fi

    echo "Review worktree ready at: $TARGET_PATH (detached HEAD at $PR_HEAD_SHA, read-only)"
    exit 0
    ;;

  done)
    JOB_NAME="${1:-}"
    if [[ -z "$JOB_NAME" ]]; then
      echo "Usage: scripts/worktree.sh done <job-name>" >&2
      exit 1
    fi

    TARGET_PATH="$SCRATCH_DIR/opensand-$JOB_NAME"
    if [[ ! -d "$TARGET_PATH" ]]; then
      # Also check if passed as raw path
      if [[ -d "$JOB_NAME" ]]; then
        TARGET_PATH="$JOB_NAME"
      else
        echo "FAIL: worktree directory does not exist: $TARGET_PATH" >&2
        exit 1
      fi
    fi

    echo "==> Verifying safety for worktree removal: $TARGET_PATH..."
    if ! check_worktree_safe_to_remove "$TARGET_PATH" "$ROOT"; then
      exit 1
    fi

    echo "Removing worktree $TARGET_PATH..."
    "${GIT_EXEC[@]}" worktree remove --force "$TARGET_PATH" >/dev/null 2>&1 || rm -rf "$TARGET_PATH"
    "${GIT_EXEC[@]}" worktree prune >/dev/null 2>&1 || true
    echo "PASS: successfully removed $TARGET_PATH (remote branches untouched)."
    exit 0
    ;;

  list)
    echo "==> OpenSand worktrees in $SCRATCH_DIR:"
    printf "%-32s %-28s %-8s %-10s %-8s %s\n" "WORKTREE" "BRANCH" "STATUS" "MERGED" "SIZE" "LAST COMMIT"
    printf "%-32s %-28s %-8s %-10s %-8s %s\n" "--------" "------" "------" "------" "----" "-----------"

    if [[ -d "$SCRATCH_DIR" ]]; then
      for dir in "$SCRATCH_DIR"/opensand-*; do
        [[ -d "$dir" ]] || continue

        wt_name="$(basename "$dir")"
        if is_forbidden_worktree_path "$dir"; then
          continue
        fi

        branch="detached"
        if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          b_name=$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || true)
          if [[ -n "$b_name" ]]; then
            branch="$b_name"
          fi

          status="clean"
          if is_worktree_dirty "$dir"; then
            status="dirty"
          fi

          merged="no"
          if is_worktree_merged "$dir" "$ROOT"; then
            merged="yes"
          fi

          last_commit=$(git -C "$dir" log -1 --format="%cd" --date=short 2>/dev/null || echo "unknown")
        else
          status="not-git"
          merged="unknown"
          last_commit="unknown"
        fi

        size=$(du -sh "$dir" 2>/dev/null | awk '{print $1}' || echo "unknown")

        printf "%-32s %-28s %-8s %-10s %-8s %s\n" "$wt_name" "$branch" "$status" "$merged" "$size" "$last_commit"
      done
    fi
    exit 0
    ;;

  prune)
    MODE="dry-run"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --yes)
          MODE="live"
          shift
          ;;
        --dry-run)
          MODE="dry-run"
          shift
          ;;
        *)
          echo "FAIL: unknown option '$1'" >&2
          echo "Usage: scripts/worktree.sh prune [--dry-run|--yes]" >&2
          exit 1
          ;;
      esac
    done

    echo "==> Pruning clean & merged opensand-* worktrees (Mode: $MODE)..."
    PRUNED_COUNT=0

    if [[ -d "$SCRATCH_DIR" ]]; then
      for dir in "$SCRATCH_DIR"/opensand-*; do
        [[ -d "$dir" ]] || continue
        wt_name="$(basename "$dir")"

        # Check safety predicate via shared helper
        if check_worktree_safe_to_remove "$dir" "$ROOT" 2>/dev/null; then
          if [[ "$MODE" == "live" ]]; then
            echo "Pruning $wt_name..."
            "${GIT_EXEC[@]}" worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
            "${GIT_EXEC[@]}" worktree prune >/dev/null 2>&1 || true
            PRUNED_COUNT=$((PRUNED_COUNT + 1))
          else
            echo "DRY RUN: would remove $wt_name ($dir)"
            PRUNED_COUNT=$((PRUNED_COUNT + 1))
          fi
        else
          # Skipped (dirty, unmerged, forbidden, or invalid)
          continue
        fi
      done
    fi

    if [[ "$MODE" == "live" ]]; then
      echo "PASS: pruned $PRUNED_COUNT worktrees."
    else
      echo "DRY RUN complete: $PRUNED_COUNT worktrees eligible for pruning."
    fi
    exit 0
    ;;

  -h|--help|"")
    echo "Usage: scripts/worktree.sh <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  new <job-name> [--branch <b>]   Create a new scratch worktree based on origin/main"
    echo "  review <PR>                    Create or refresh a detached read-only review worktree"
    echo "  done <job-name>                Remove worktree if clean and merged into origin/main"
    echo "  list                           List opensand-* worktrees with status, size, and commit date"
    echo "  prune [--dry-run|--yes]        Prune all clean & merged opensand-* worktrees"
    exit 0
    ;;

  *)
    echo "FAIL: unknown command '$cmd'" >&2
    echo "Usage: scripts/worktree.sh <new|review|done|list|prune>" >&2
    exit 1
    ;;
esac
