#!/usr/bin/env bash
# OpenSand automated worktree lifecycle manager
# Usage:
#   scripts/worktree.sh base
#   scripts/worktree.sh new <job-name> [--branch <b>]
#   scripts/worktree.sh review <PR>
#   scripts/worktree.sh save "<message>" [-- <path>...]
#   scripts/worktree.sh done <job-name>
#   scripts/worktree.sh list
#   scripts/worktree.sh prune [--dry-run|--yes]
# Job worktrees hang off one reusable base clone (OPENSAND_BASE_DIR, default <scratch>/opensand-base,
# cloned from OPENSAND_REPO_URL or the current origin), refreshed to origin/main by `base` and by `new`.
# `save` (run inside a job worktree) commits with the repository's hooks on, refuses a staged diff
# that matches a secret pattern, pushes the branch, and opens a draft PR on the first push.
set -euo pipefail

# Resolve script root (can be called from any clone or directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Guard: refuse to run from or against the owner checkout ($HOME/dev/opensand)
source "$SCRIPT_DIR/lib/owner-guard.sh"
assert_not_owner_checkout "worktree.sh"

# Source shared safety predicates
source "$SCRIPT_DIR/lib/worktree-safety.sh"
# Free-space guard measures the writable data volume (DISK_PATH), not the system snapshot
source "$SCRIPT_DIR/lib/free-space.sh"

SCRATCH_DIR="${OPENSAND_SCRATCH_DIR:-$HOME/dev/_scratch}"
CLEAN_DISK_SCRIPT="${OPENSAND_CLEAN_DISK_SCRIPT:-$SCRIPT_DIR/clean-disk.sh}"

# Guard: never act on the owner's main checkout, from any directory and under any command
# (`new|review|save|done` all pass through here before touching a repository or a target path).
REAL_CWD="$(pwd -P)"
if ! assert_not_main_checkout "$REAL_CWD" "current directory"; then
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

# Guard: the repository a command would act on is never the main checkout, even when the script is
# invoked from elsewhere as ~/dev/opensand/scripts/worktree.sh.
SOURCE_TOP=$("${GIT_EXEC[@]}" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -n "$SOURCE_TOP" ]] && ! assert_not_main_checkout "$SOURCE_TOP" "source repository"; then
  exit 1
fi

BASE_DIR="$(base_clone_dir)"

# ensure_base: create the base clone if absent, else refresh it; leaves it detached at origin/main.
ensure_base() {
  local url="${OPENSAND_REPO_URL:-}"
  if [[ -z "$url" ]]; then
    url=$("${GIT_EXEC[@]}" remote get-url origin 2>/dev/null || echo "https://github.com/Philosopher0707/opensand.git")
  fi

  if is_fixed_protected_path "$BASE_DIR"; then
    echo "FAIL: base clone path $BASE_DIR is a protected repository or application path." >&2
    return 1
  fi

  if [[ ! -e "$BASE_DIR" ]]; then
    mkdir -p "$(dirname "$BASE_DIR")"
    echo "Cloning base clone into $BASE_DIR..."
    if ! git clone --quiet "$url" "$BASE_DIR"; then
      echo "FAIL: could not clone $url into $BASE_DIR." >&2
      rm -rf "$BASE_DIR"
      return 1
    fi
  elif ! git -C "$BASE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "FAIL: $BASE_DIR exists but is not a git clone; move it aside." >&2
    return 1
  elif is_worktree_dirty "$BASE_DIR"; then
    echo "FAIL: base clone $BASE_DIR has uncommitted changes; it must stay clean (nobody works there)." >&2
    return 1
  fi

  if ! git -C "$BASE_DIR" fetch --quiet origin main; then
    echo "FAIL: could not fetch origin/main in base clone $BASE_DIR." >&2
    return 1
  fi
  git -C "$BASE_DIR" checkout --quiet --detach origin/main
  echo "Base clone: $BASE_DIR at $(git -C "$BASE_DIR" rev-parse --short origin/main) (origin/main)"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  base)
    if [[ $# -gt 0 ]]; then
      echo "FAIL: 'base' takes no arguments (got '$1')" >&2
      exit 1
    fi
    ensure_base || exit 1
    exit 0
    ;;

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

    assert_not_main_checkout "$TARGET_PATH" "target path" || exit 1

    # 1. Refuse if path already exists
    if [[ -e "$TARGET_PATH" ]]; then
      echo "FAIL: worktree path already exists: $TARGET_PATH" >&2
      exit 1
    fi

    # 3. Check free disk space (< 3 GB check after attempting clean-disk.sh --yes)
    AVAIL_GB=$(df -k "$DISK_PATH" 2>/dev/null | awk 'NR==2 {print int($4 / 1024 / 1024)}' || echo "10")
    if [[ "$AVAIL_GB" -lt 3 ]]; then
      echo "Notice: free disk is under 3 GB (${AVAIL_GB} GB available on $DISK_PATH). Attempting clean-disk.sh --yes..."
      if [[ -f "$CLEAN_DISK_SCRIPT" ]]; then
        bash "$CLEAN_DISK_SCRIPT" --yes || true
      fi
      AVAIL_GB=$(df -k "$DISK_PATH" 2>/dev/null | awk 'NR==2 {print int($4 / 1024 / 1024)}' || echo "10")
      if [[ "$AVAIL_GB" -lt 3 ]]; then
        echo "FAIL: Insufficient disk space: ${AVAIL_GB} GB available on $DISK_PATH (< 3 GB required)." >&2
        exit 1
      fi
    fi

    # 4. Create or refresh the base clone (fetches origin/main) and work through it from here on
    ensure_base || exit 1
    GIT_EXEC=(git -C "$BASE_DIR")

    ORIGIN_MAIN_SHA=$("${GIT_EXEC[@]}" rev-parse origin/main 2>/dev/null || echo "")
    if [[ -z "$ORIGIN_MAIN_SHA" ]]; then
      echo "FAIL: could not determine origin/main SHA." >&2
      exit 1
    fi

    # 5. Refuse if the branch already exists locally (base clone) or on the remote (asked live)
    if "${GIT_EXEC[@]}" show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
      echo "FAIL: branch '$TARGET_BRANCH' already exists locally." >&2
      exit 1
    fi
    if "${GIT_EXEC[@]}" ls-remote --exit-code --heads origin "$TARGET_BRANCH" >/dev/null 2>&1; then
      echo "FAIL: branch '$TARGET_BRANCH' already exists on remote origin." >&2
      exit 1
    fi

    # 6. Create worktree
    mkdir -p "$SCRATCH_DIR"
    "${GIT_EXEC[@]}" worktree add -b "$TARGET_BRANCH" "$TARGET_PATH" origin/main >/dev/null

    BASE_SHA=$(git -C "$TARGET_PATH" rev-parse HEAD)
    echo "Created worktree at: $TARGET_PATH"
    echo "Branch: $TARGET_BRANCH"
    echo "Base SHA: $BASE_SHA"
    echo "Next: work in $TARGET_PATH; 'scripts/worktree.sh save \"<message>\"' there commits, pushes and opens the draft PR on the first push."
    exit 0
    ;;

  save)
    SAVE_MSG="${1:-}"
    if [[ -z "$SAVE_MSG" || "$SAVE_MSG" == -* ]]; then
      echo "Usage: scripts/worktree.sh save \"<message>\" [-- <path>...]" >&2
      exit 1
    fi
    shift
    SAVE_PATHS=()
    if [[ $# -gt 0 ]]; then
      if [[ "$1" != "--" ]]; then
        echo "FAIL: unexpected argument '$1' (paths go after --)" >&2
        exit 1
      fi
      shift
      SAVE_PATHS=("$@")
    fi

    WT=$(git rev-parse --show-toplevel 2>/dev/null || true)
    if [[ -z "$WT" ]]; then
      echo "FAIL: 'save' must run inside a job worktree." >&2
      exit 1
    fi
    WT="$(cd "$WT" && pwd -P)"
    if ! assert_not_main_checkout "$WT" "worktree"; then
      exit 1
    fi
    if is_forbidden_worktree_path "$WT"; then
      echo "FAIL: $WT is a protected repository or application path (the base clone or ~/dev/opensand); save only works in a job worktree." >&2
      exit 1
    fi
    if [[ ! -f "$WT/.git" ]]; then
      echo "FAIL: $WT is not a linked job worktree (create one with: scripts/worktree.sh new <job-name>)." >&2
      exit 1
    fi
    SAVE_BRANCH=$(git -C "$WT" symbolic-ref --short HEAD 2>/dev/null || true)
    if [[ -z "$SAVE_BRANCH" ]]; then
      echo "FAIL: $WT has a detached HEAD; save needs a branch." >&2
      exit 1
    fi
    if [[ "$SAVE_BRANCH" == "main" || "$SAVE_BRANCH" == "master" ]]; then
      echo "FAIL: refusing to save onto '$SAVE_BRANCH'; work on a job branch." >&2
      exit 1
    fi

    # 1. Stage by explicit path (never `git add -A`): the given paths, or every changed or new file
    #    in this private job worktree listed one by one (ignored files stay out).
    if [[ ${#SAVE_PATHS[@]} -gt 0 ]]; then
      git -C "$WT" add -- "${SAVE_PATHS[@]}"
    else
      while IFS= read -r -d '' entry; do
        # porcelain -z: "XY path" (a rename is followed by a second NUL-separated old path)
        status_code="${entry:0:2}"
        entry_path="${entry:3}"
        if [[ "$status_code" == R* || "$status_code" == C* ]]; then
          IFS= read -r -d '' _old_path || true
        fi
        git -C "$WT" add -- "$entry_path"
      done < <(git -C "$WT" status --porcelain -z --untracked-files=all)
    fi

    # 1a. Never stage regenerated screenshots: a full verify.sh rewrites packages/desktop/artifacts/*.png
    #     as a side effect, and pr-gate refuses a binary in the diff. They go back to HEAD and are
    #     reported; naming one after `--` is the way to commit a real screenshot change.
    STAGED_PATHS=()
    while IFS= read -r -d '' staged_path; do
      STAGED_PATHS+=("$staged_path")
    done < <(git -C "$WT" diff --cached --name-only -z --diff-filter=ACMR)
    SKIPPED_ARTIFACTS=()
    if [[ ${#STAGED_PATHS[@]} -gt 0 ]]; then
      for staged_path in "${STAGED_PATHS[@]}"; do
        is_artifact_png "$staged_path" || continue
        explicit=1
        if [[ ${#SAVE_PATHS[@]} -gt 0 ]]; then
          for named_path in "${SAVE_PATHS[@]}"; do
            named_path="${named_path#./}"
            if [[ "$staged_path" == "$named_path" || "$staged_path" == "$named_path"/* ]]; then
              explicit=0
              break
            fi
          done
        fi
        [[ "$explicit" -eq 1 ]] || continue
        if git -C "$WT" cat-file -e "HEAD:$staged_path" 2>/dev/null; then
          git -C "$WT" restore --source=HEAD --staged --worktree -- "$staged_path"
        else
          git -C "$WT" restore --staged -- "$staged_path"
        fi
        SKIPPED_ARTIFACTS+=("$staged_path")
      done
    fi
    if [[ ${#SKIPPED_ARTIFACTS[@]} -gt 0 ]]; then
      echo "Skipped ${#SKIPPED_ARTIFACTS[@]} regenerated screenshot(s), restored to HEAD (name one after -- to commit it):"
      printf '  %s\n' "${SKIPPED_ARTIFACTS[@]}"
    fi

    # 1b. Regenerate docs/lessons/INDEX.md from the lesson files and stage it, so a lesson added here
    #     cannot reach the branch with a stale index (CI rejected exactly that twice). A failing script
    #     stops the save before anything is committed. Skipped when the worktree has no lessons directory.
    if [[ -f "$WT/scripts/lessons-index.sh" && -d "$WT/docs/lessons" ]]; then
      if ! (cd "$WT" && bash scripts/lessons-index.sh) >/dev/null; then
        echo "FAIL: scripts/lessons-index.sh failed; nothing was committed or pushed." >&2
        exit 1
      fi
      git -C "$WT" add -- docs/lessons/INDEX.md
    fi

    # 2. Secret scan of what is staged. Nothing is committed or pushed when it finds something.
    if FINDINGS=$(staged_secret_findings "$WT"); then
      echo "FAIL: refusing to save: the staged diff looks like it contains secrets (nothing committed, nothing pushed):" >&2
      echo "$FINDINGS" | sed 's/^/  /' >&2
      echo "Remove or unstage them (git restore --staged <path>), keep real secrets out of the repo, then save again." >&2
      exit 1
    fi

    # 3. Commit with the repository's hooks on. A failing hook stops here: no push.
    if git -C "$WT" diff --cached --quiet; then
      echo "Nothing new to commit."
    else
      if ! git -C "$WT" commit -q -m "$SAVE_MSG"; then
        echo "FAIL: commit was refused (a hook or git failed); nothing was pushed." >&2
        exit 1
      fi
      echo "Committed: $(git -C "$WT" log -1 --format='%h %s')"
    fi

    # 4. Push the branch (never forced) and verify the remote has exactly our HEAD.
    if ! git -C "$WT" push -q -u origin "$SAVE_BRANCH" 2>&1; then
      echo "FAIL: push of '$SAVE_BRANCH' failed; the work is committed locally but NOT on the remote." >&2
      exit 1
    fi
    LOCAL_SHA=$(git -C "$WT" rev-parse HEAD)
    REMOTE_SHA=$(git -C "$WT" ls-remote origin "refs/heads/$SAVE_BRANCH" 2>/dev/null | awk '{print $1}')
    if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
      echo "FAIL: after the push, origin/$SAVE_BRANCH is ${REMOTE_SHA:-missing}, expected $LOCAL_SHA." >&2
      exit 1
    fi
    echo "Pushed: origin/$SAVE_BRANCH at ${LOCAL_SHA:0:7} (verified on the remote)"

    # 5. First push: open a draft PR (a branch with no commits yet cannot have one). If an existing PR
    #    cannot be ruled out, say so instead of guessing.
    if ! PR_COUNT=$(cd "$WT" && gh pr list --head "$SAVE_BRANCH" --state all --json number --jq 'length' 2>/dev/null); then
      echo "FAIL: saved and pushed, but could not check for an existing PR (gh failed); run save again to retry." >&2
      exit 1
    fi
    if [[ ! "$PR_COUNT" =~ ^[0-9]+$ ]]; then
      echo "FAIL: saved and pushed, but gh gave an unreadable PR count ('$PR_COUNT'); run save again to retry." >&2
      exit 1
    fi
    if [[ "$PR_COUNT" -eq 0 ]]; then
      PR_TITLE="${SAVE_MSG%%$'\n'*}"
      PR_BODY="Draft opened automatically by \`scripts/worktree.sh save\` on the first push of \`$SAVE_BRANCH\`. Not ready for review or merge: run \`gh pr ready\` when it is, then \`scripts/pr-gate.sh --when-green <PR>\`."
      if ! PR_URL=$(cd "$WT" && gh pr create --draft --base main --head "$SAVE_BRANCH" --title "$PR_TITLE" --body "$PR_BODY" 2>&1); then
        echo "FAIL: saved and pushed, but the draft PR could not be created: $PR_URL" >&2
        exit 1
      fi
      echo "Draft PR: ${PR_URL##*$'\n'}"
    else
      echo "PR: already exists for '$SAVE_BRANCH'"
    fi
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

    assert_not_main_checkout "$TARGET_PATH" "target path" || exit 1

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
      remove_worktree "$TARGET_PATH"
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
    assert_not_main_checkout "$TARGET_PATH" "target path" || exit 1
    if ! check_worktree_safe_to_remove "$TARGET_PATH" "$ROOT"; then
      exit 1
    fi

    echo "Removing worktree $TARGET_PATH..."
    DONE_BRANCH=$(git -C "$TARGET_PATH" symbolic-ref --short HEAD 2>/dev/null || true)
    DONE_COMMON=$(git -C "$TARGET_PATH" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
    remove_worktree "$TARGET_PATH"
    # The branch is merged (checked above), so its local ref goes too: otherwise `new` with the same
    # name would refuse. Remote branches are never touched.
    if [[ -n "$DONE_BRANCH" && -n "$DONE_COMMON" ]]; then
      git --git-dir="$DONE_COMMON" branch -D "$DONE_BRANCH" >/dev/null 2>&1 || true
    fi
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

    echo "==> Pruning clean, merged, non-live opensand-* worktrees (Mode: $MODE)..."
    PRUNED_COUNT=0

    if [[ -d "$SCRATCH_DIR" ]]; then
      for dir in "$SCRATCH_DIR"/opensand-*; do
        [[ -d "$dir" ]] || continue
        wt_name="$(basename "$dir")"

        # Check safety predicate (clean, merged, not live) via shared helper
        if check_worktree_safe_to_prune "$dir" "$ROOT" 2>/dev/null; then
          if [[ "$MODE" == "live" ]]; then
            echo "Pruning $wt_name..."
            remove_worktree "$dir"
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
    echo "  base                           Create or refresh the reusable base clone (default <scratch>/opensand-base) at origin/main"
    echo "  new <job-name> [--branch <b>]   Create a new scratch worktree based on origin/main (via the base clone)"
    echo "  save \"<message>\" [-- <path>...]  In a job worktree: stage, refuse secrets, commit (hooks on), push, open a draft PR on first push"
    echo "  review <PR>                    Create or refresh a detached read-only review worktree"
    echo "  done <job-name>                Remove worktree if clean and merged into origin/main"
    echo "  list                           List opensand-* worktrees with status, size, and commit date"
    echo "  prune [--dry-run|--yes]        Prune clean, merged, non-live opensand-* worktrees (live = open PR or file changed in last 2h)"
    exit 0
    ;;

  *)
    echo "FAIL: unknown command '$cmd'" >&2
    echo "Usage: scripts/worktree.sh <base|new|save|review|done|list|prune>" >&2
    exit 1
    ;;
esac
