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
#   - The reusable base clone (OPENSAND_BASE_DIR, default <scratch>/opensand-base) and any primary clone
#     that owns linked worktrees are protected: they are never removed, pruned or cleaned.
#   - Removal goes through the owning repository's common git dir, not the caller's current repo.
#   - Nothing is removed while it holds commits that exist on no remote branch (has_unpushed_work).
#   - staged_secret_findings scans a worktree's staged diff for secrets (used by worktree.sh save).

# base_clone_dir: where the reusable base clone lives
base_clone_dir() {
  echo "${OPENSAND_BASE_DIR:-${OPENSAND_SCRATCH_DIR:-$HOME/dev/_scratch}/opensand-base}"
}

# main_checkout_dir: the owner's main checkout, which no worktree command may act on.
# OPENSAND_MAIN_CHECKOUT moves it for the selftest only; nothing else should set it.
main_checkout_dir() {
  echo "${OPENSAND_MAIN_CHECKOUT:-$HOME/dev/opensand}"
}

# is_main_checkout <path>: 0 when <path> is the main checkout or below it, after resolving symlinks.
is_main_checkout() {
  local target_dir="$1" real_target real_main
  real_target="$(cd "$target_dir" 2>/dev/null && pwd -P || echo "$target_dir")"
  real_main="$(cd "$(main_checkout_dir)" 2>/dev/null && pwd -P || echo "$(main_checkout_dir)")"
  if [[ "$real_target" == "$real_main" || "$real_target" == "$real_main"/* ]]; then
    return 0
  fi
  return 1
}

# assert_not_main_checkout <path> [what]
# Refuses (returns 1, message on stderr) when <path> is the owner's main checkout, whether reached
# directly or through a symlink. Work belongs in a scratch worktree. OPENSAND_ALLOW_MAIN_CHECKOUT=1
# is the override the selftest uses; it is not for normal work.
assert_not_main_checkout() {
  local target_dir="$1" what="${2:-path}"
  if [[ "${OPENSAND_ALLOW_MAIN_CHECKOUT:-0}" == "1" || "${OPENSAND_OWNER:-0}" == "1" ]]; then
    return 0
  fi
  if is_main_checkout "$target_dir"; then
    echo "FAIL: refusing to run worktree commands on the main checkout $(main_checkout_dir) ($what: $target_dir)." >&2
    echo "      Work in a scratch worktree: scripts/worktree.sh new <job-name> (OPENSAND_ALLOW_MAIN_CHECKOUT=1 is for tests only)." >&2
    return 1
  fi
  return 0
}

# Artifact screenshots are rewritten by every full verify.sh (a window-harness side effect), so `save`
# never stages them unless the path was named explicitly after `--`.
# See docs/lessons/2026-11-19-full-test-run-rewrites-tracked-screenshots.md.
ARTIFACT_PNG_GLOB="packages/desktop/artifacts/*.png"

# is_artifact_png <repo-relative path>
is_artifact_png() {
  case "$1" in
    $ARTIFACT_PNG_GLOB) return 0 ;;
  esac
  return 1
}

# is_fixed_protected_path <path>: ~/dev/opensand, ~/.opensand, /Applications/OpenSand.app and below
is_fixed_protected_path() {
  local target_dir="$1" forbidden
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

is_forbidden_worktree_path() {
  local target_dir="$1"
  if is_fixed_protected_path "$target_dir"; then
    return 0
  fi

  # The base clone is the repository the job worktrees hang off: never a removal target.
  local base real_target real_base
  base="$(base_clone_dir)"
  real_target="$(cd "$target_dir" 2>/dev/null && pwd -P || echo "$target_dir")"
  real_base="$(cd "$base" 2>/dev/null && pwd -P || echo "$base")"
  if [[ "$real_target" == "$real_base" ]]; then
    return 0
  fi

  # A primary clone (its .git is a directory) that still owns linked worktrees is protected too.
  if [[ -d "$target_dir/.git" ]]; then
    local owned
    owned=$(git -C "$target_dir" worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true)
    if [[ "${owned:-0}" -gt 1 ]]; then
      return 0
    fi
  fi
  return 1
}

# has_unpushed_work <worktree_dir>
# Returns 0 and sets UNPUSHED_COUNT when HEAD has commits that are on no remote-tracking branch.
# An unreadable HEAD counts as unpushed (fail closed).
has_unpushed_work() {
  local target_dir="$1" count
  UNPUSHED_COUNT=0
  if ! count=$(git -C "$target_dir" rev-list --count HEAD --not --remotes 2>/dev/null); then
    UNPUSHED_COUNT="unknown"
    return 0
  fi
  if [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]]; then
    UNPUSHED_COUNT="$count"
    return 0
  fi
  return 1
}

# staged_secret_findings <worktree_dir>
# Scans what is staged (added lines only, plus file names) for secrets. Prints one line per finding
# as "path[:line]: reason" and never the matching text. Returns 0 when something was found, 1 when clean.
# Patterns are token-shaped so words such as "disk-usage" or "task-queue" do not match "sk-".
# .env files are refused by name (.env, .env.*, *.env) except the documented templates
# .env.example, .env.sample, .env.template.
SECRET_PATTERN_NAMES=("sk- API key" "GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)" "AWS access key (AKIA)" "private key block")
SECRET_PATTERNS=(
  '(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}'
  '(^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}'
  '(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}'
  'BEGIN ([A-Z0-9]+ )*PRIVATE KEY'
)
staged_secret_findings() {
  local target_dir="$1" found=1 path base line file="" lineno=0 i
  local hunk_re='^@@ -[0-9,]+ \+([0-9]+)'

  while IFS= read -r -d '' path; do
    base="${path##*/}"
    case "$base" in
      .env.example|.env.sample|.env.template) ;;
      .env|.env.*|*.env)
        echo "$path: .env file is staged"
        found=0
        ;;
    esac
  done < <(git -C "$target_dir" diff --cached --name-only -z --diff-filter=ACMR 2>/dev/null)

  while IFS= read -r line; do
    if [[ "$line" == "+++ b/"* ]]; then
      file="${line#+++ b/}"
      continue
    fi
    if [[ "$line" =~ $hunk_re ]]; then
      lineno="${BASH_REMATCH[1]}"
      continue
    fi
    if [[ "$line" == "+"* ]]; then
      for i in "${!SECRET_PATTERNS[@]}"; do
        if [[ "$line" =~ ${SECRET_PATTERNS[$i]} ]]; then
          echo "$file:$lineno: looks like a ${SECRET_PATTERN_NAMES[$i]}"
          found=0
        fi
      done
      lineno=$((lineno + 1))
    fi
  done < <(git -C "$target_dir" diff --cached --no-color -U0 --diff-filter=ACMR 2>/dev/null)

  return "$found"
}

# remove_worktree <worktree_dir>
# Removes a linked worktree through the repository that owns it (its common git dir), so it works
# from any current directory, then prunes that repository's stale worktree records.
remove_worktree() {
  local target_dir="$1" common owner
  common=$(git -C "$target_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [[ -z "$common" ]]; then
    rm -rf "$target_dir"
    return 0
  fi
  if [[ "$(basename "$common")" == ".git" ]]; then
    owner=(git -C "$(dirname "$common")")
  else
    owner=(git --git-dir="$common")
  fi
  "${owner[@]}" worktree remove --force "$target_dir" >/dev/null 2>&1 || rm -rf "$target_dir"
  "${owner[@]}" worktree prune >/dev/null 2>&1 || true
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

  if has_unpushed_work "$target_dir"; then
    echo "Refusing: $target_dir has $UNPUSHED_COUNT commit(s) that are on no remote branch (unpushed). Run: scripts/worktree.sh save \"<message>\"" >&2
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
