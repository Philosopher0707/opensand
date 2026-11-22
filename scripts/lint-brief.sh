#!/usr/bin/env bash
# Shape lint for bot briefs: every brief must name Goal, Done when, Scope and Report back,
# and contain no unresolved "TODO" markers.
# Usage: scripts/lint-brief.sh <brief.md> [...]   ('-' reads stdin)
# Exit 0 all briefs well-shaped and TODO-free, 1 a section missing or TODO present, 2 bad usage / unreadable file.
set -uo pipefail

LABELS=("Goal" "Done when" "Scope" "Report back")
REQUIRED_SECTIONS=("Goal" "Done[[:space:]]+when" "Scope" "Report[[:space:]]+back[^:]*")

usage() { echo "Usage: scripts/lint-brief.sh <brief.md> [...]  ('-' reads stdin)" >&2; }

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

FAILED=0
for brief in "$@"; do
  if [[ "$brief" != "-" && ( ! -f "$brief" || ! -r "$brief" ) ]]; then
    echo "FAIL: cannot read brief: $brief" >&2
    exit 2
  fi
done

lint_one() {
  local file="$1" text missing="" i label pattern
  if [[ "$file" == "-" ]]; then
    text="$(cat)"
  else
    if [[ ! -f "$file" || ! -r "$file" ]]; then
      echo "FAIL: cannot read brief: $file" >&2
      return 1
    fi
    text="$(cat "$file")"
  fi

  for i in "${!REQUIRED_SECTIONS[@]}"; do
    pattern="${REQUIRED_SECTIONS[$i]}"
    # Accepts "Goal:", "**Goal:**" and markdown headings like "## Goal".
    if ! grep -qiE "(^|[^[:alnum:]])${pattern}[[:space:]]*:|^#+[[:space:]]+${pattern}([^[:alnum:]]|$)" <<<"$text"; then
      if [[ -n "$missing" ]]; then missing+=", "; fi
      missing+="${LABELS[$i]}"
    fi
  done

  if [[ -n "$missing" ]]; then
    echo "FAIL: $file missing sections: $missing"
    return 1
  fi

  if grep -q "TODO" <<<"$text"; then
    echo "FAIL: $file contains unresolved TODO"
    return 1
  fi

  echo "PASS: $file has Goal, Done when, Scope, Report back"
  return 0
}

for brief in "$@"; do
  lint_one "$brief" || FAILED=1
done

exit "$FAILED"
