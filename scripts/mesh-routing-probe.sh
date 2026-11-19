#!/usr/bin/env bash
# Mutation probe for the Phase 7 start-rung routing (docs/design/phase7-mesh-tournament.md §10 S5).
#
# Proves the mesh-routing suite can fail: it loosens the §2.3 qualification
# check in routing.ts (a rung with no qualifying record would be started
# anyway), runs the mesh-routing tests, and requires them RED; then it
# restores the file byte-for-byte and requires the suite GREEN again. Exit 0
# only on GREEN -> RED -> GREEN.
#
# The hard 5-minute cap uses perl's alarm(), which survives the exec into
# mutation-probe.sh and its child test runs (macOS has no `timeout` binary).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec perl -e 'alarm shift @ARGV; exec @ARGV' 300 \
  scripts/mutation-probe.sh \
  packages/engine/src/mesh/routing.ts \
  's/modelStats.rateWilsonLow >= thresholds.minPassRate/modelStats.rateWilsonLow > -1/' \
  -- bash -c 'pnpm --filter @opensand/engine build && pnpm --filter @opensand/engine test -- mesh-routing'
