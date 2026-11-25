#!/usr/bin/env bash
# Pre-commit guard for OpenSand.
# - Runs the full test suite and the TypeScript build.
# - Blocks a blanket commit: if every tracked modified file is staged,
#   refuse (signature of `git add -A` / `git add .`).
# - Refuses staged or untracked PNG test artifacts before build/tests run.
# Emergency override: OPENSAND_ALLOW_BLANKET=1 git commit ...
# Intentional binary override: ALLOW_BINARY_ARTIFACTS=1 git commit ...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Determine the actual work tree we were invoked from. Prefer the current
# working directory's repo when the script lives in a bare repo, so that
# checks run in the same tree that is being committed (not in the bare dir
# that the hook shim points at).
TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$TOP" ]]; then
  ROOT="$TOP"
fi
cd "$ROOT"

# Fail closed if we cannot determine the repo
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "x pre-commit: not inside a git work tree (GIT_* env stripped); refusing to run checks." >&2
  echo "  Override with: OPENSAND_ALLOW_BLANKET=1 git commit ..." >&2
  exit 1
fi

# --- Blanket-add guard -------------------------------------------------
if [[ "${OPENSAND_ALLOW_BLANKET:-0}" != "1" ]]; then
  modified="$(git diff --name-only)"
  staged="$(git diff --cached --name-only)"
  if [[ -n "$modified" ]]; then
    staged_count="$(printf '%s\n' "$staged" | grep -c . || true)"
    modified_count="$(printf '%s\n' "$modified" | grep -c . || true)"
    if [[ "$staged_count" -gt 0 && "$staged_count" -ge "$modified_count" ]]; then
      echo "x pre-commit: refusing a commit that stages every modified file."
      echo "  This is the signature of a blanket add (git add -A / git add .)."
      echo "  Stage by explicit path instead: git add <explicit paths>"
      exit 1
    fi
  fi
fi

# --- PNG artifact guard -------------------------------------------------
# Match pr-gate.sh Check 3: every PNG is a forbidden binary unless the caller
# explicitly opts in. There are no path exceptions for docs/ or build/.
if [[ "${ALLOW_BINARY_ARTIFACTS:-0}" != "1" ]]; then
  staged_png_count=0
  while IFS= read -r -d '' path; do
    case "$path" in
      *.[pP][nN][gG])
        if [[ "$staged_png_count" -eq 0 ]]; then
          echo "x pre-commit: refusing staged PNG binary artifact(s):" >&2
        fi
        printf '  %s\n' "$path" >&2
        staged_png_count=$((staged_png_count + 1))
        ;;
    esac
  done < <(git diff --cached --name-only -z)
  if [[ "$staged_png_count" -gt 0 ]]; then
    echo "  Remove or unstage them (git restore --staged <path>), then commit again." >&2
    exit 1
  fi

  untracked_png_count=0
  while IFS= read -r -d '' path; do
    case "$path" in
      *.[pP][nN][gG])
        if [[ "$untracked_png_count" -eq 0 ]]; then
          echo "x pre-commit: refusing untracked PNG test artifact(s):" >&2
        fi
        printf '  %s\n' "$path" >&2
        untracked_png_count=$((untracked_png_count + 1))
        ;;
    esac
  done < <(git ls-files --others --exclude-standard -z)
  if [[ "$untracked_png_count" -gt 0 ]]; then
    echo "  Delete them or move them to the gitignored .opensand-snapshots/ directory." >&2
    exit 1
  fi
else
  echo "WARNING: ALLOW_BINARY_ARTIFACTS=1: allowing PNG binary artifacts; use scripts/pr-gate.sh --allow-binary for the matching PR gate." >&2
fi

# --- Staged secret scan -----------------------------------------------
# Same scan `scripts/worktree.sh save` runs: added lines only, file and line
# named, matched value never printed. See scripts/lib/worktree-safety.sh.
# Load it beside this script: the hook may run with ROOT set to another tree.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/worktree-safety.sh"
if FINDINGS=$(staged_secret_findings "$ROOT"); then
  echo "x pre-commit: refusing a commit whose staged changes look like secrets (values are not printed):" >&2
  printf '%s\n' "$FINDINGS" | sed 's/^/  /' >&2
  echo "  Remove or unstage them (git restore --staged <path>), then commit again." >&2
  exit 1
fi

# --- Hook environment scrub -------------------------------------------
# git exports GIT_DIR, GIT_INDEX_FILE, ... to hooks. Any test that runs git
# would inherit them and write into THIS repo's config, refs and index
# (core.bare=true, stray refs). Run build and tests with none of them set.
for v in GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY \
         GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CEILING_DIRECTORIES; do
  unset "$v"
done
for v in $(env | grep -E '^GIT_' | cut -d= -f1 || true); do
  unset "$v"
done

# --- Tripwire ------------------------------------------------------------
# Snapshot repo-local state the suite must never touch; compare afterwards.
snapshot_config="$(git config --local --list)"
snapshot_refs="$(git for-each-ref refs/opensand)"

# Overridable only so the hook's own test can substitute the commands.
BUILD_CMD="${OPENSAND_PRECOMMIT_BUILD_CMD:-pnpm run build}"
TEST_CMD="${OPENSAND_PRECOMMIT_TEST_CMD:-pnpm run test}"

# Real-window tests launch Electron; a commit hook must never take over the owner's screen.
# CI and verify.sh leave this unset, so they still run the full suite (hidden and harmless).
if [[ "${OPENSAND_PRECOMMIT_REAL_WINDOW:-}" != "1" ]]; then
  export OPENSAND_SKIP_REAL_WINDOW=1
fi

status=0
echo "==> pre-commit: $BUILD_CMD"
bash -c "$BUILD_CMD" || status=$?
if [[ "$status" -eq 0 ]]; then
  echo "==> pre-commit: $TEST_CMD"
  bash -c "$TEST_CMD" || status=$?
fi

tripped=0
after_config="$(git config --local --list)"
after_refs="$(git for-each-ref refs/opensand)"
if [[ "$after_config" != "$snapshot_config" ]]; then
  echo "x pre-commit: TRIPWIRE: the build/tests changed this repo's local git config:" >&2
  diff <(printf '%s\n' "$snapshot_config") <(printf '%s\n' "$after_config") >&2 || true
  tripped=1
fi
if [[ "$after_refs" != "$snapshot_refs" ]]; then
  echo "x pre-commit: TRIPWIRE: the build/tests changed refs/opensand:" >&2
  diff <(printf '%s\n' "$snapshot_refs") <(printf '%s\n' "$after_refs") >&2 || true
  tripped=1
fi
if [[ "$tripped" -ne 0 ]]; then
  echo "  A test is writing into the real repo. Fix that test; the commit is refused." >&2
  exit 1
fi
if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi
echo "pre-commit passed"
