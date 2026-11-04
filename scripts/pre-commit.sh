#!/usr/bin/env bash
# Pre-commit guard for OpenSand.
# - Runs the full test suite and the TypeScript build.
# - Blocks a blanket commit: if every tracked modified file is staged,
#   refuse (signature of `git add -A` / `git add .`).
# Emergency override: OPENSAND_ALLOW_BLANKET=1 git commit ...
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
