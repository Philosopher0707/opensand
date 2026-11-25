#!/usr/bin/env bash
# Hermetic rebase test for the docs/lessons/INDEX.md merge driver.
# Usage: scripts/lessons-index-merge-selftest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensand-lessons-merge-selftest.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A hook may export GIT_DIR/GIT_WORK_TREE; never let this fixture touch that repository.
while IFS='=' read -r name _; do
  case "$name" in GIT_*) unset "$name" ;; esac
done < <(env)
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

REPO="$WORK/repo"
mkdir -p "$REPO/scripts" "$REPO/docs/lessons"
/bin/cp "$ROOT/scripts/setup-git.sh" "$ROOT/scripts/lessons-index.sh" "$REPO/scripts/"
if [[ -f "$ROOT/.gitattributes" ]]; then
  /bin/cp "$ROOT/.gitattributes" "$REPO/.gitattributes"
fi
cd "$REPO"

lesson() { # lesson <filename> <title>
  printf '# %s\n\n**Trap:** Generated indexes conflict when parallel lessons land.\n**Root Cause:** Each branch rewrites the same index from its own lesson set.\n**Rule:** Regenerate the index from the merged lesson files.\n' "$2" > "docs/lessons/$1"
}

lesson 2026-11-24-base.md "Base lesson"
bash scripts/lessons-index.sh >/dev/null
git init -q
git config user.name "Lessons Merge Selftest"
git config user.email "lessons-merge-selftest@example.com"
git add scripts docs
if [[ -f .gitattributes ]]; then git add .gitattributes; fi
git commit -q -m "base lesson"
git branch base

git checkout -q -b lesson-alpha base
lesson 2026-11-25-alpha.md "Alpha lesson"
bash scripts/lessons-index.sh >/dev/null
git add docs/lessons
git commit -q -m "add alpha lesson"

git checkout -q -b lesson-bravo base
lesson 2026-11-25-bravo.md "Bravo lesson"
bash scripts/lessons-index.sh >/dev/null
git add docs/lessons
git commit -q -m "add bravo lesson"
BRAVO_SHA=$(git rev-parse HEAD)

bash scripts/setup-git.sh
FIRST_DRIVER=$(git config --get merge.lessons-index.driver)
bash scripts/setup-git.sh
SECOND_DRIVER=$(git config --get merge.lessons-index.driver)
if [[ "$FIRST_DRIVER" != 'scripts/lessons-index.sh --merge %B > %A' || "$SECOND_DRIVER" != "$FIRST_DRIVER" ]]; then
  echo "FAIL setup-git: driver registration is not idempotent"
  exit 1
fi
echo "PASS setup-git idempotent"

git checkout -q lesson-alpha
status=0
rebase_out=$(GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase lesson-bravo 2>&1) || status=$?
if [[ "$status" -ne 0 ]]; then
  echo "FAIL rebase-with-driver: git rebase exited $status"
  printf '%s\n' "$rebase_out" | sed 's/^/    | /'
  if git rev-parse -q --verify REBASE_HEAD >/dev/null; then
    echo "Unmerged files:"
    git diff --name-only --diff-filter=U | sed 's/^/    | /'
    git rebase --abort >/dev/null 2>&1 || true
  fi
  exit 1
fi
echo "PASS rebase-with-driver (exit 0)"

if [[ "$(git rev-parse HEAD^)" != "$BRAVO_SHA" ]]; then
  echo "FAIL rebase-with-driver: alpha was not rebased onto bravo"
  exit 1
fi
if ! bash scripts/lessons-index.sh --check; then
  echo "FAIL rebase-with-driver: regenerated index is stale"
  exit 1
fi
for name in 2026-11-25-alpha.md 2026-11-25-bravo.md; do
  if [[ ! -f "docs/lessons/$name" ]] || ! grep -qF "$name" docs/lessons/INDEX.md; then
    echo "FAIL rebase-with-driver: $name or its index entry is missing"
    exit 1
  fi
done
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FAIL rebase-with-driver: worktree is not clean"
  git status --short
  exit 1
fi
echo "PASS both lessons retained and index current"
echo "ALL LESSONS INDEX MERGE SELFTESTS PASSED."
