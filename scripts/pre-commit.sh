#!/usr/bin/env bash
# Pre-commit guard for OpenSand.
# - Runs the full test suite and the TypeScript build.
# - Blocks a blanket commit: if every tracked modified file is staged,
#   refuse (signature of `git add -A` / `git add .`).
# Emergency override: OPENSAND_ALLOW_BLANKET=1 git commit ...
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

# --- Hook environment scrub -------------------------------------------
# git exports GIT_DIR, GIT_INDEX_FILE, ... to hooks. Any test that runs git
# would inherit them and write into THIS repo's config, refs and index
# (core.bare=true, stray refs). Run build and tests with none of them set.
for v in GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY \
         GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CEILING_DIRECTORIES; do
  unset "$v"
done

# --- Tripwire ------------------------------------------------------------
# Snapshot repo-local state the suite must never touch; compare afterwards.
snapshot_config="$(git config --local --list)"
snapshot_refs="$(git for-each-ref refs/opensand)"

# Overridable only so the hook's own test can substitute the commands.
BUILD_CMD="${OPENSAND_PRECOMMIT_BUILD_CMD:-pnpm run build}"
TEST_CMD="${OPENSAND_PRECOMMIT_TEST_CMD:-pnpm run test}"

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
