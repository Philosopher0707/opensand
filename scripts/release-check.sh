#!/usr/bin/env bash
# Release Gate Check: verifies repository integrity and executes packaged app smoke test
# Usage:
#   scripts/release-check.sh [path/to/OpenSand.zip]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export TMPDIR="${TMPDIR:-$(mktemp -d)}"

echo "release-check: running workspace verification suite..."
SKIP_INSTALL=1 bash "$REPO_ROOT/scripts/verify.sh"

echo "release-check: running packaged app smoke verification..."
bash "$REPO_ROOT/scripts/smoke-packaged.sh" "${1:-}"

echo "release-check: all pre-release gates passed."
