#!/usr/bin/env bash
# OpenSand Phase 5 row brief generator
# Usage:
#   scripts/brief-row.sh <row> [--out <file>]
# Exit codes:
#   0 - Success (brief emitted and lint passed)
#   2 - Usage error / bad or missing row
#   3 - Row already marked 'done' in inventory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INVENTORY_FILE="${OPENSAND_INVENTORY_FILE:-$ROOT/docs/design/phase5-view-inventory.md}"
SERVER_FILE="${OPENSAND_DESKTOP_SERVER_FILE:-$ROOT/packages/desktop/src/desktop-server.ts}"
LINT_SCRIPT="${OPENSAND_LINT_SCRIPT:-$SCRIPT_DIR/lint-brief.sh}"

usage() {
  echo "Usage: scripts/brief-row.sh <row> [--out <file>]" >&2
  exit 2
}

ROW=""
OUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      if [[ $# -lt 2 || -z "$2" ]]; then
        usage
      fi
      OUT_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    -*)
      usage
      ;;
    *)
      if [[ -z "$ROW" ]]; then
        ROW="$1"
        shift
      else
        usage
      fi
      ;;
  esac
done

if [[ -z "$ROW" || ! "$ROW" =~ ^[0-9]+$ || "$ROW" -eq 0 ]]; then
  usage
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "FAIL: inventory file not found: $INVENTORY_FILE" >&2
  exit 2
fi

if [[ ! -f "$SERVER_FILE" ]]; then
  echo "FAIL: server file not found: $SERVER_FILE" >&2
  exit 2
fi

# Determine base SHA
GIT_BASE_SHA="$(git -C "$ROOT" rev-parse --short origin/main 2>/dev/null || git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "723722b")"

# Generate brief via python processor
BRIEF_CONTENT="$(python3 - "$INVENTORY_FILE" "$SERVER_FILE" "$ROW" "$GIT_BASE_SHA" <<'PY'
import os
import re
import sys

inventory_path = sys.argv[1]
server_path = sys.argv[2]
try:
    target_row = int(sys.argv[3])
except ValueError:
    print(f"FAIL: invalid row number: {sys.argv[3]}", file=sys.stderr)
    sys.exit(2)
git_sha = sys.argv[4]

with open(inventory_path, 'r', encoding='utf-8') as f:
    inventory_lines = f.readlines()

row_data = None
for line in inventory_lines:
    m = re.match(r'^\s*\|\s*(\d+)\s*\|(.*)', line)
    if m and int(m.group(1)) == target_row:
        parts = [p.strip() for p in line.strip().split('|')[1:-1]]
        row_data = parts
        break

if not row_data:
    print(f"FAIL: row {target_row} not found in {inventory_path}", file=sys.stderr)
    sys.exit(2)

status = row_data[5].lower() if len(row_data) > 5 else ""
if status == 'done':
    print(f"FAIL: row {target_row} is already marked done in {inventory_path}", file=sys.stderr)
    sys.exit(3)

feature_raw = row_data[1]
app_lines = row_data[2] if len(row_data) > 2 else ""
html_lines = row_data[3] if len(row_data) > 3 else ""
what_missing = row_data[6] if len(row_data) > 6 else ""

bold_match = re.search(r'\*\*([^*]+)\*\*', feature_raw)
feature_title = bold_match.group(1) if bold_match else feature_raw.split()[0]
slug = feature_title.split()[0].lower()
pascal_name = slug.capitalize()

with open(server_path, 'r', encoding='utf-8') as f:
    server_lines = f.readlines()

server_filename = os.path.basename(server_path)
routes = []
method_pattern = re.compile(r"req\.method\s*===\s*['\"]([A-Z]+)['\"]")
comment_pattern = re.compile(r"//\s*API:\s*(?:[A-Z]+\s+)?(/\S+)")
validation_pattern = re.compile(r"^\s*(if\s*\(!body\.[^)]+\)\s*\{)")

for i, line in enumerate(server_lines):
    line_num = i + 1
    if "pathname" in line and "req.method" in line:
        method_match = method_pattern.search(line)
        if not method_match:
            continue
        method = method_match.group(1)
        
        path = None
        for back in range(1, 4):
            if i - back >= 0:
                prev_line = server_lines[i - back]
                cm = comment_pattern.search(prev_line)
                if cm and f"api/{slug}" in cm.group(1):
                    path = cm.group(1)
                    break
        if not path:
            eq_m = re.search(r"pathname\s*===\s*['\"]([^'\"]+)['\"]", line)
            if eq_m and f"api/{slug}" in eq_m.group(1):
                path = eq_m.group(1)
            else:
                sw_m = re.search(r"pathname\.startsWith\(['\"]([^'\"]+)['\"]\)", line)
                if sw_m and f"api/{slug}" in sw_m.group(1):
                    path = sw_m.group(1)
                    if path.endswith('/'):
                        path = path + ':id'
                    ew_m = re.search(r"pathname\.endsWith\(['\"]([^'\"]+)['\"]\)", line)
                    if ew_m:
                        path = path + ew_m.group(1)
        
        if not path:
            continue
            
        validation = None
        for fwd in range(1, 9):
            if i + fwd < len(server_lines):
                next_line = server_lines[i + fwd]
                vm = validation_pattern.search(next_line)
                if vm:
                    validation = vm.group(1).strip()
                    break
        routes.append((method, path, line_num, validation))

routes_formatted = []
for m, p, l, v in routes:
    routes_formatted.append(f"     - {m} {p} — {server_filename} L{l}")
    if v:
        routes_formatted.append(f"       validation: {v}")

routes_block = "\n".join(routes_formatted) if routes_formatted else "     - (None registered in desktop-server.ts)"
missing_note = f"\nTODO: {what_missing}" if what_missing else ""

brief = f"""## Goal
Implement the {feature_title} view in the Preact shell for Phase 5 View Inventory Row {target_row}, with parity to legacy `packages/desktop/renderer/app.js` {app_lines} and `index.html` {html_lines}, verified in a real Electron window with zero horizontal overflow.{missing_note}

## Scope
1. Files to create/modify (base: origin/main `{git_sha}`):
   - Server routes (verified in `packages/desktop/src/desktop-server.ts`, do not change them):
{routes_block}
   - Create `packages/desktop/src/shell/{slug}-model.ts`:
     - Types: TODO: {pascal_name} types.
     - Pure helpers: TODO: pure helpers for {slug}.
     - Unit tests in `packages/desktop/test/{slug}-model.test.ts` covering every helper.
   - `packages/desktop/renderer-next/src/data.ts`: add to `ShellData` TODO: data methods for {slug}; implement in `windowBridgeData()` bridge-first, else HTTP to the routes above.
   - Create `packages/desktop/renderer-next/src/views/{pascal_name}View.tsx`:
     - TODO: subnav tabs, view header, cards grid / controls.
   - `packages/desktop/renderer-next/src/Shell.tsx`: add `<{pascal_name}View />` for `view === "{slug}"`.
   - `packages/desktop/renderer-next/src/shell.css`: {slug} view styling; no horizontal overflow at 960x740 and 1920x1080.
   - Create `packages/desktop/test/{slug}-real-window.test.ts`: real Electron window test at 960x740 and 1920x1080 with zero horizontal overflow.
   - `docs/design/phase5-view-inventory.md`: Row {target_row} → `done` with a one-line description and the test names.
2. Off-limits:
   - Do NOT edit or delete `packages/desktop/renderer/app.js` or `index.html` (kept until the Phase 5 deletion gate).
   - Do NOT edit `desktop-server.ts`, `packages/coordinator` or `packages/local-exec-daemon`.
   - Leave open PR #159 alone. Never touch `~/dev/opensand`, `~/.opensand`, or `/Applications/OpenSand.app`.

## Fixed Rules
- Worktree via `scripts/worktree.sh new phase5-{slug}-view` off origin/main; remove with `scripts/worktree.sh done` after merge.
- Commit and push work-in-progress early so a stop loses nothing.
- Work economically: grep then read only needed line ranges; run only the {slug} tests while coding; run verify.sh once before the PR; never re-run a passing check.
- No lockfile or .github changes; stop and ask if one seems needed.
- No `--no-verify`. `TMPDIR=$(mktemp -d) SKIP_INSTALL=1 bash scripts/verify.sh` must exit 0.
- Proof files (screenshots, logs) stay OUTSIDE the repo in `/Users/philosopher/dev/_scratch/proof-logs/{slug}/`; report their paths.
- Merge only through `bash scripts/pr-gate.sh --when-green <PR>`; do not re-run it on an already merged PR.
- If the brief contradicts the code, follow the code and record it in `docs/lessons/` in the same PR.
- Anything done by hand twice becomes a script with a selftest, listed in `scripts/README.md`.
- Report `df -h /` before and after.

## Done when
1. `<{pascal_name}View />` renders with parity to legacy view; TODO: specific interactions.
2. `{slug}-model.test.ts` and `{slug}-real-window.test.ts` pass at 960x740 and 1920x1080 with zero horizontal overflow.
3. `TMPDIR=$(mktemp -d) SKIP_INSTALL=1 bash scripts/verify.sh` exits 0.
4. PR merged via `bash scripts/pr-gate.sh --when-green <PR>` with main CI green on the merge commit.
5. Row {target_row} in `docs/design/phase5-view-inventory.md` is `done`.

## Report back
1. PR number and merge commit SHA on main.
2. Table of changed files with exact line ranges and symbols.
3. Test counts for the unit and real-window tests, and verify.sh exit code.
4. Absolute paths of proof screenshots and logs in `/Users/philosopher/dev/_scratch/proof-logs/{slug}/`.
5. `df -h /` before and after; anything skipped, with its risk. Keep the report short, in English.
"""

sys.stdout.write(brief)
PY
)"

if [[ -n "$OUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  printf '%s\n' "$BRIEF_CONTENT" > "$OUT_FILE"
  # Also print to stdout so routes and methods are visible
  printf '%s\n' "$BRIEF_CONTENT"
  if [[ -f "$LINT_SCRIPT" ]]; then
    bash "$LINT_SCRIPT" "$OUT_FILE"
  fi
else
  printf '%s\n' "$BRIEF_CONTENT"
fi
