#!/usr/bin/env bash
# Quality scores: preflight (no build, no money), build, then score 12 coding tasks.
#
#   scripts/quality-scores.sh [--engine native|external:<id>] [--model <id>] [--tasks <ids>] [--control-only]
#
# Exit codes: 0 green, 1 failed control or check, 2 bad config/target. A run writes
# evals/quality-scores/runs/<UTC-run-id>.json and .md. Credentials never reach a
# child unless a :free model is explicitly selected with the person's own key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

echo "==> [quality-scores] preflight"
node evals/quality-scores/runner.mjs --preflight "$@" >/dev/null

echo "==> [quality-scores] building engine and coordinator"
pnpm --filter "@opensand/coordinator..." build >/dev/null

echo "==> [quality-scores] scoring tasks"
exec node evals/quality-scores/runner.mjs "$@"
