#!/usr/bin/env bash
# Pre-commit guard for OpenSand.
# - Runs the full test suite and the TypeScript build.
# - Blocks a blanket commit: if every tracked modified file is staged,
#   refuse (signature of `git add -A` / `git add .`).
# Emergency override: OPENSAND_ALLOW_BLANKET=1 git commit ...
set -euo pipefail

# Strip ambient GIT_* variables so a nested `git commit` (e.g. from
# coordinator's git-manager tests, or a sandboxed agent env that leaks
# GIT_DIR/GIT_WORK_TREE) cannot re-enter this hook and recurse.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX GIT_CEILING_DIRECTORIES

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

echo "==> pre-commit: pnpm run build"
pnpm run build
echo "==> pre-commit: pnpm run test"
pnpm run test
echo "pre-commit passed"
