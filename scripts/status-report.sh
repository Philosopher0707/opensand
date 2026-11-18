#!/usr/bin/env bash
# OpenSand read-only owner status report.
# One command prints a short markdown (or --json) summary of repo activity.
# It never pushes, merges, comments, edits or authenticates with a token in output.
# Usage: scripts/status-report.sh [--hours N] [--json]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOURS=24
JSON=0

usage() {
  cat >&2 <<'EOF'
Usage: scripts/status-report.sh [--hours N] [--json]
  --hours N   look back N hours for merged PRs (default 24)
  --json      emit the same data as JSON instead of markdown
  -h, --help  show this help
Read-only: nothing here pushes, merges, comments or edits anything.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || { echo "FAIL: --hours needs a positive whole number" >&2; exit 1; }
      HOURS="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "FAIL: unknown argument '$1'" >&2; usage; exit 1 ;;
  esac
done

if ! gh auth status >/dev/null 2>&1; then
  echo "FAIL: gh is not signed in to GitHub. Run 'gh auth login', then retry." >&2
  exit 1
fi

# Single place for gh failures: never echo gh's own stderr (no token can leak).
gh_data() {
  local out
  if ! out="$(gh "$@" 2>/dev/null)"; then
    echo "FAIL: 'gh $*' failed (auth, network or permissions). Nothing was changed." >&2
    exit 1
  fi
  printf '%s' "$out"
}

CUTOFF=$(( $(date -u +%s) - HOURS * 3600 ))

MERGED_RAW="$(gh_data pr list --state merged --json number,title,mergedAt,mergeCommit --limit 100)"
MERGED="$(printf '%s' "$MERGED_RAW" | jq --argjson c "$CUTOFF" \
  '[.[] | select((.mergedAt | fromdateiso8601) >= $c)
          | {number: .number, title: (.title // ""), merge_sha: (.mergeCommit.oid // "")}]')"

OPEN_RAW="$(gh_data pr list --state open --json number,title,mergeStateStatus,statusCheckRollup --limit 100)"
OPEN="$(printf '%s' "$OPEN_RAW" | jq \
  '[.[] | {
      number: .number,
      title: (.title // ""),
      behind_main: (.mergeStateStatus == "BEHIND"),
      ci_state: (
        [ .statusCheckRollup[]? | ((.conclusion // .state // "PENDING") | ascii_upcase) ]
        | if length == 0 then "NONE"
          elif any(test("FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE")) then "FAILING"
          elif any(test("PENDING|IN_PROGRESS|QUEUED|WAITING|REQUESTED")) then "PENDING"
          else "GREEN" end )
    }]')"

RUN_RAW="$(gh_data run list --branch main --limit 1 --json status,conclusion,displayTitle,url)"
MAIN_CI="$(printf '%s' "$RUN_RAW" | jq \
  '.[0] // {} | {status: (.status // "none"),
                 conclusion: (if (.conclusion // "") == "" then "pending" else .conclusion end),
                 display_title: (.displayTitle // ""), url: (.url // "")}')"

LATEST_RELEASE="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
[[ -n "$LATEST_RELEASE" ]] || LATEST_RELEASE="none"

if [[ -d /System/Volumes/Data ]]; then DISK_PATH=/System/Volumes/Data; else DISK_PATH=/; fi
DISK_LINE="$(df -h "$DISK_PATH" | awk 'NR==2 {print $2"\t"$4"\t"$5}')"
IFS=$'\t' read -r DISK_SIZE DISK_AVAIL DISK_CAP <<<"$DISK_LINE"
DISK="$(jq -n --arg path "$DISK_PATH" --arg size "${DISK_SIZE:-?}" \
  --arg available "${DISK_AVAIL:-?}" --arg capacity "${DISK_CAP:-?}" \
  '{path: $path, size: $size, available: $available, capacity: $capacity}')"

GEN="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORT="$(jq -n \
  --arg generated_at "$GEN" \
  --argjson window_hours "$HOURS" \
  --argjson merged_prs "$MERGED" \
  --argjson open_prs "$OPEN" \
  --argjson main_ci "$MAIN_CI" \
  --arg latest_release "$LATEST_RELEASE" \
  --argjson disk "$DISK" \
  '{generated_at: $generated_at, window_hours: $window_hours,
    merged_prs: $merged_prs, open_prs: $open_prs, main_ci: $main_ci,
    latest_release: $latest_release, disk: $disk}')"

if [[ "$JSON" -eq 1 ]]; then
  printf '%s\n' "$REPORT" | jq .
else
  printf '%s\n' "$REPORT" | jq -r '
    "# OpenSand status (last \(.window_hours)h)",
    "Generated: \(.generated_at)   (read-only: no GitHub state was changed)",
    "",
    "## Merged PRs (\(.merged_prs | length))",
    (if (.merged_prs | length) == 0 then "- none"
     else (.merged_prs[] | "- #\(.number) \(.title) — `\(.merge_sha)`") end),
    "",
    "## Open PRs (\(.open_prs | length))",
    (if (.open_prs | length) == 0 then "- none"
     else (.open_prs[] | "- #\(.number) \(.title) — CI: \(.ci_state), behind main: \(if .behind_main then "yes" else "no" end)") end),
    "",
    "## Latest main CI",
    "- \(.main_ci.conclusion) / \(.main_ci.status) — \(.main_ci.display_title)",
    "- \(.main_ci.url)",
    "",
    "## Latest release",
    "- \(.latest_release)",
    "",
    "## Disk (data volume: \(.disk.path))",
    "- \(.disk.available) free of \(.disk.size) (\(.disk.capacity) used)"
  '
fi
