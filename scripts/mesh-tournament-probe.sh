#!/usr/bin/env bash
# Mutation probe for the Phase 7 tournament runner (docs/design/phase7-mesh-tournament.md §10 S4).
#
# Proves the mesh-tournament suite can fail: it flips the attempt outcome's
# check verdict in tournament.ts (a failed check would be recorded as passed),
# runs the mesh-tournament tests, and requires them RED; then it restores the
# file byte-for-byte and requires the suite GREEN again. Exit 0 only on
# GREEN -> RED -> GREEN.
#
# The hard 5-minute cap uses perl's alarm(), which survives the exec into
# mutation-probe.sh and its child test runs (macOS has no `timeout` binary).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec perl -e 'alarm shift @ARGV; exec @ARGV' 300 \
  scripts/mutation-probe.sh \
  packages/engine/src/mesh/tournament.ts \
  's/const outcome: AttemptOutcome = !checkResult.passed/const outcome: AttemptOutcome = checkResult.passed/' \
  -- bash -c 'pnpm --filter @opensand/engine build && pnpm --filter @opensand/engine test -- mesh-tournament'
