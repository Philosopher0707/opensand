#!/usr/bin/env bash
# Prints a report built from GitHub and git, not by hand:
# changed files with line ranges (from the diff hunks), head commit,
# CI run ids and conclusion per job, and the outputs of proof-red-green and mutate if their log files are given.
# Markdown, ready to paste as a handoff report.
#
# Usage:
#   scripts/proof-report.sh <PR-number> [--red-green <file>] [--mutate <file>]
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd))"

PR=""
RED_GREEN_LOG=""
MUTATE_LOG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --red-green|--red-green-log)
      RED_GREEN_LOG="$2"
      shift 2
      ;;
    --mutate|--mutate-log)
      MUTATE_LOG="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/proof-report.sh <PR-number> [--red-green <file>] [--mutate <file>]"
      exit 0
      ;;
    *)
      if [[ -z "$PR" && "$1" =~ ^[0-9]+$ ]]; then
        PR="$1"
        shift
      elif [[ -z "$RED_GREEN_LOG" && -f "$1" ]]; then
        RED_GREEN_LOG="$1"
        shift
      elif [[ -z "$MUTATE_LOG" && -f "$1" ]]; then
        MUTATE_LOG="$1"
        shift
      else
        echo "FAIL: unknown or unexpected argument: $1" >&2
        echo "Usage: scripts/proof-report.sh <PR-number> [--red-green <file>] [--mutate <file>]" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "FAIL: missing PR number" >&2
  echo "Usage: scripts/proof-report.sh <PR-number> [--red-green <file>] [--mutate <file>]" >&2
  exit 1
fi

PR_JSON=""
if ! PR_JSON=$(gh pr view "$PR" --json number,title,state,headRefOid,headRefName,baseRefName,url,statusCheckRollup,author 2>&1); then
  echo "FAIL: gh pr view failed for PR #$PR: $PR_JSON" >&2
  exit 1
fi

DIFF_TEXT=""
if ! DIFF_TEXT=$(gh pr diff "$PR" 2>&1); then
  echo "FAIL: gh pr diff failed for PR #$PR: $DIFF_TEXT" >&2
  exit 1
fi

node -e '
const fs = require("fs");
const path = require("path");

const prData = JSON.parse(process.argv[1]);
const diffText = process.argv[2];
const rgLogPath = process.argv[3];
const mutLogPath = process.argv[4];
const rootDir = process.argv[5];

// Parse diff hunks into changed files and line ranges
const fileRanges = new Map();
let currentFile = null;

for (const line of diffText.split("\n")) {
  if (line.startsWith("diff --git ")) {
    const parts = line.split(" ");
    currentFile = parts[parts.length - 1].replace(/^b\//, "");
    if (!fileRanges.has(currentFile)) {
      fileRanges.set(currentFile, []);
    }
  } else if (line.startsWith("@@ ") && currentFile) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      const start = parseInt(m[1], 10);
      const count = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const end = count > 0 ? start + count - 1 : start;
      const range = count > 1 ? `L${start}–L${end}` : `L${start}`;
      fileRanges.get(currentFile).push(range);
    }
  }
}

// Format markdown report
console.log(`### Task Completion Report: PR #${prData.number} — ${prData.title}`);
console.log("");
console.log(`- **Pull Request:** [${prData.url}](${prData.url})`);
console.log(`- **State:** \`${prData.state}\` (branch \`${prData.headRefName}\` → \`${prData.baseRefName}\`)`);
console.log(`- **Head Commit:** \`${prData.headRefOid}\``);
console.log("");

console.log("---");
console.log("");
console.log("#### 1. Changed Files & Line Ranges");
console.log("");
console.log("| Changed File | Exact Line Range(s) |");
console.log("|---|---|");
for (const [file, ranges] of fileRanges.entries()) {
  const displayRanges = ranges.length > 0 ? ranges.join(", ") : "—";
  console.log(`| [\`${file}\`](file://${path.resolve(rootDir, file)}) | ${displayRanges} |`);
}
console.log("");

console.log("---");
console.log("");
console.log("#### 2. CI Status & Run IDs");
console.log("");
const rollup = prData.statusCheckRollup || [];
if (rollup.length === 0) {
  console.log("No status checks recorded yet.");
} else {
  console.log("| Job Name | Status | Conclusion | Details URL / Run ID |");
  console.log("|---|---|---|---|");
  for (const check of rollup) {
    const name = check.name || check.context || "check";
    const status = check.status || "UNKNOWN";
    const conclusion = check.conclusion || "PENDING";
    const url = check.detailsUrl || check.targetUrl || "";
    let runIdStr = url;
    const runMatch = url.match(/\/actions\/runs\/(\d+)/);
    if (runMatch) {
      runIdStr = `[Run #${runMatch[1]}](${url})`;
    } else if (url) {
      runIdStr = `[Link](${url})`;
    } else {
      runIdStr = "—";
    }
    console.log(`| ${name} | \`${status}\` | \`${conclusion}\` | ${runIdStr} |`);
  }
}
console.log("");

if (rgLogPath && fs.existsSync(rgLogPath)) {
  console.log("---");
  console.log("");
  console.log("#### 3. Red-Green Proof Output");
  console.log("");
  console.log("```");
  console.log(fs.readFileSync(rgLogPath, "utf8").trim());
  console.log("```");
  console.log("");
}

if (mutLogPath && fs.existsSync(mutLogPath)) {
  console.log("---");
  console.log("");
  console.log("#### 4. Mutation Probe Output");
  console.log("");
  console.log("```");
  console.log(fs.readFileSync(mutLogPath, "utf8").trim());
  console.log("```");
  console.log("");
}
' "$PR_JSON" "$DIFF_TEXT" "$RED_GREEN_LOG" "$MUTATE_LOG" "$ROOT"
