#!/usr/bin/env bash
# One-shot ship harness for a verified phase: checks -> scan -> explicit stage -> commit -> JSON receipt.
# Usage:  SHIP_PATHS="src/a.ts test/a.test.ts" bash scripts/ship_phase.sh "commit title" [phase]
# Never stages implicitly; pre-existing lockfile edits and untracked user work stay out.
set -euo pipefail

TITLE="${1:?usage: SHIP_PATHS=... bash scripts/ship_phase.sh <title> [phase]}"
PHASE="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${SHIP_PATHS:-}" ]]; then
  echo "SHIP_PATHS must list explicit files to stage" >&2
  exit 2
fi

read -r -a PATHS <<< "$SHIP_PATHS"

echo "==> build"
pnpm run build >/tmp/opensand-ship-build.log 2>&1 || { tail -30 /tmp/opensand-ship-build.log >&2; exit 1; }
echo "==> test"
pnpm run test >/tmp/opensand-ship-test.log 2>&1 || { tail -40 /tmp/opensand-ship-test.log >&2; exit 1; }
PASSED="$(grep -E 'test: # pass ' /tmp/opensand-ship-test.log | awk '{s+=$NF} END {print s+0}')"
FAILED="$(grep -E 'test: # fail ' /tmp/opensand-ship-test.log | awk '{s+=$NF} END {print s+0}')"
if [[ "$FAILED" != "0" ]]; then echo "tests failed: $FAILED" >&2; exit 1; fi

echo "==> stage explicit paths"
git add -- "${PATHS[@]}"

STAGED="$(git diff --cached --name-only)"
for forbidden in '.env' '.agent/' '.wisp/'; do
  if printf '%s\n' "$STAGED" | grep -q "^${forbidden}"; then
    echo "refusing to stage protected path: $forbidden" >&2
    git reset -q -- "${PATHS[@]}"
    exit 1
  fi
done

echo "==> secret scan on staged diff"
if git diff --cached | grep -nE '(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{24,})' >/tmp/opensand-ship-secret.log; then
  echo "possible secret in staged diff:" >&2
  cat /tmp/opensand-ship-secret.log >&2
  git reset -q -- "${PATHS[@]}"
  exit 1
fi

# The repo deliberately keeps pnpm-lock.yaml unstaged; use the documented
# override instead of --no-verify when the blanket guard would misfire.
if git status --short -- pnpm-lock.yaml | grep -q '^ M'; then
  export OPENSAND_ALLOW_BLANKET=1
fi

echo "==> commit"
git commit -m "$TITLE" >/tmp/opensand-ship-commit.log 2>&1 || { tail -30 /tmp/opensand-ship-commit.log >&2; exit 1; }
COMMIT="$(git rev-parse --short HEAD)"

printf '{"status":"ok","commit":"%s","tests_passed":%s,"tests_failed":%s,"phase":"%s","files_changed":%s,"timestamp":"%s"}\n' \
  "$COMMIT" "$PASSED" "$FAILED" "$PHASE" "${#PATHS[@]}" "$(date -u +%FT%TZ)"
