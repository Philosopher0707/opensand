#!/usr/bin/env bash
# Mutation probe for the Phase 7 mesh judge (docs/design/phase7-mesh-tournament.md §10 S3).
#
# Proves the mesh-judge suite can fail: it flips the Stage 0 exit-code check in
# judge.ts (isCheckPassed), runs the mesh-judge tests, and requires them RED;
# then scripts/mutation-probe.sh restores the file byte-for-byte and requires
# the suite GREEN again. Exit 0 only on GREEN -> RED -> GREEN.
#
# The hard 5-minute cap uses perl's alarm(), which survives the exec into
# mutation-probe.sh and its child test runs (macOS has no `timeout` binary).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec perl -e 'alarm shift @ARGV; exec @ARGV' 300 \
  scripts/mutation-probe.sh \
  packages/engine/src/mesh/judge.ts \
  's/return checkExit === 0;/return checkExit !== 0;/' \
  -- bash -c 'pnpm --filter @opensand/engine build && pnpm --filter @opensand/engine test -- mesh-judge'
