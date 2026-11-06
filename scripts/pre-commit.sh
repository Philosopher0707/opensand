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

echo "==> pre-commit: pnpm run build"
pnpm run build
echo "==> pre-commit: pnpm run test"
pnpm run test
echo "pre-commit passed"
