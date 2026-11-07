#!/usr/bin/env bash
# Provenance review gate
# Ensures no binary or release artifact is distributed while provenance review is OPEN.
# Exits 1 if any table row in docs/provenance-review.md has an unreviewed verdict ("—").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$ROOT/docs/provenance-review.md"

if [[ ! -f "$DOC" ]]; then
  echo "Provenance gate error: $DOC not found!" >&2
  exit 1
fi

echo "Checking provenance review status in docs/provenance-review.md..."

# Check table rows with pending verdict "—"
UNREVIEWED=$(grep -E '^\|.*\|.*—\s*\|$' "$DOC" || true)

if [[ -n "$UNREVIEWED" ]]; then
  echo "Provenance review gate FAILED: The following files have pending verdict '—':" >&2
  echo "$UNREVIEWED" >&2
  echo "" >&2
  echo "Binaries must not be distributed until all provenance review rows have recorded verdicts." >&2
  exit 1
fi

echo "Provenance review gate PASSED: All files have recorded verdicts."
exit 0
