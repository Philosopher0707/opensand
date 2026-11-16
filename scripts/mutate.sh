#!/usr/bin/env bash
# Thin wrapper: the mutation probe lives in scripts/mutation-probe.sh, which supports both
# mutation forms (perl substitution, or one line replaced). This name is kept so anything
# that still calls mutate.sh keeps working; it forwards every argument unchanged.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/mutation-probe.sh" "$@"
