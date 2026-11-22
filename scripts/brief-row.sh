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
APP_FILE="${OPENSAND_APP_FILE:-$ROOT/packages/desktop/renderer/app.js}"
HTML_FILE="${OPENSAND_HTML_FILE:-$ROOT/packages/desktop/renderer/index.html}"
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

if [[ -z "$ROW" ]]; then
  usage
fi

if ! [[ "$ROW" =~ ^[0-9]+$ ]] || [[ "$ROW" -le 0 ]]; then
  usage
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "FAIL: inventory file not found: $INVENTORY_FILE" >&2
  exit 2
fi

if [[ ! -f "$SERVER_FILE" ]]; then
  echo "FAIL: desktop server file not found: $SERVER_FILE" >&2
  exit 2
fi

# Determine base git commit sha if git available
GIT_BASE_SHA=""
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_BASE_SHA="$(git -C "$ROOT" rev-parse --short origin/main 2>/dev/null || git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "HEAD")"
else
  GIT_BASE_SHA="HEAD"
fi

generate_brief() {
  python3 - "$INVENTORY_FILE" "$SERVER_FILE" "$APP_FILE" "$HTML_FILE" "$ROW" "$GIT_BASE_SHA" <<'PY'
import os
import re
import sys

inventory_path = sys.argv[1]
server_path = sys.argv[2]
app_path = sys.argv[3]
html_path = sys.argv[4]

try:
    target_row = int(sys.argv[5])
except ValueError:
    print(f"FAIL: invalid row number: {sys.argv[5]}", file=sys.stderr)
    sys.exit(2)
git_sha = sys.argv[6]

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
app_lines_invent = row_data[2] if len(row_data) > 2 else ""
html_lines_invent = row_data[3] if len(row_data) > 3 else ""
what_missing = row_data[6] if len(row_data) > 6 else ""

bold_match = re.search(r'\*\*([^*]+)\*\*', feature_raw)
feature_title = bold_match.group(1) if bold_match else feature_raw.split()[0]
slug = feature_title.split()[0].lower()
pascal_name = slug.capitalize()

stems = [slug, slug.capitalize(), pascal_name]
if slug.endswith("ies"):
    stems.extend([slug[:-3] + "y", (slug[:-3] + "y").capitalize()])
elif slug.endswith("s"):
    stems.extend([slug[:-1], (slug[:-1]).capitalize()])

# Read app.js if present
app_lines = []
if os.path.isfile(app_path):
    with open(app_path, 'r', encoding='utf-8') as f:
        app_lines = f.readlines()

ctrl_start = None
ctrl_end = None
ctrl_fn = None
api_start = None
api_end = None
create_start = None
create_end = None

api_prefixes_from_app = set([f"api/{slug}"])
for s in stems:
    api_prefixes_from_app.add(f"api/{s.lower()}")

if app_lines:
    # 1. Controller block
    ctrl_patterns = [re.compile(rf"^\s*//\s*---\s*{re.escape(s)}\s+view\s+controller\s*---", re.IGNORECASE) for s in stems]
    any_ctrl_pattern = re.compile(r"^\s*//\s*---\s*.*view\s+controller\s*---", re.IGNORECASE)
    for i, line in enumerate(app_lines):
        if any(cp.search(line) for cp in ctrl_patterns):
            ctrl_start = i + 1
            break
    if ctrl_start:
        for i in range(ctrl_start, len(app_lines)):
            line = app_lines[i]
            if not ctrl_fn:
                fn_m = re.search(r"async\s+function\s+([a-zA-Z0-9_]+)", line)
                if fn_m:
                    ctrl_fn = fn_m.group(1)
            if any_ctrl_pattern.search(line) or (i > ctrl_start + 10 and re.match(r"^\s*//\s*---\s*.*---", line)):
                ctrl_end = i
                break
        if not ctrl_end:
            ctrl_end = len(app_lines)

        ctrl_block = "".join(app_lines[ctrl_start-1:ctrl_end])
        for p in re.findall(r"/api/([a-zA-Z0-9_\-]+)", ctrl_block):
            api_prefixes_from_app.add(f"api/{p}")

    # 2. API block
    api_patterns = [re.compile(rf"^\s*//\s*---\s*{re.escape(s)}\s+api\s*---", re.IGNORECASE) for s in stems]
    any_api_pattern = re.compile(r"^\s*//\s*---\s*.*api\s*---", re.IGNORECASE)
    for i, line in enumerate(app_lines):
        if any(ap.search(line) for ap in api_patterns):
            api_start = i + 1
            break
    if api_start:
        for i in range(api_start, len(app_lines)):
            line = app_lines[i]
            if any_api_pattern.search(line) or (i > api_start + 5 and re.match(r"^\s*//\s*---\s*.*---", line)):
                api_end = i
                break
        if not api_end:
            api_end = len(app_lines)

        api_block = "".join(app_lines[api_start-1:api_end])
        for p in re.findall(r"/api/([a-zA-Z0-9_\-]+)", api_block):
            api_prefixes_from_app.add(f"api/{p}")

    # 3. Creation block
    stem_alt = "|".join(re.escape(s) for s in stems)
    create_pattern = re.compile(rf"^\s*//\s*(?:{stem_alt})\s+creation", re.IGNORECASE)
    for i, line in enumerate(app_lines):
        if create_pattern.search(line):
            create_start = i + 1
            break
    if create_start:
        for i in range(create_start, len(app_lines)):
            line = app_lines[i]
            if re.match(r"^\s*//\s*.*creation", line) or re.match(r"^\s*//\s*---", line):
                create_end = i
                break
        if not create_end:
            create_end = len(app_lines)

legacy_app_parts = []
if api_start and api_end:
    legacy_app_parts.append(f"API L{api_start}–{api_end}")
if ctrl_start and ctrl_end:
    if ctrl_fn:
        legacy_app_parts.append(f"`{ctrl_fn}` L{ctrl_start}–{ctrl_end}")
    else:
        legacy_app_parts.append(f"controller L{ctrl_start}–{ctrl_end}")
if create_start and create_end:
    legacy_app_parts.append(f"add handlers L{create_start}–{create_end}")

if legacy_app_parts:
    legacy_app_summary = "; ".join(legacy_app_parts)
else:
    legacy_app_summary = app_lines_invent

# Read index.html if present
html_lines = []
if os.path.isfile(html_path):
    with open(html_path, 'r', encoding='utf-8') as f:
        html_lines = f.readlines()

view_line = None
view_id = None
view_element_ids = []
modal_lines = {}
modal_element_ids = {}

if html_lines:
    for i, line in enumerate(html_lines):
        for s in stems:
            m = re.search(rf'id=["\'](view{re.escape(s)})["\']', line, re.IGNORECASE)
            if m:
                view_line = i + 1
                view_id = m.group(1)
                break
        if view_line:
            break

    if view_line:
        view_end = len(html_lines)
        for i in range(view_line, len(html_lines)):
            line = html_lines[i]
            if 'class="view-panel' in line or '<!-- View' in line:
                view_end = i
                break
        view_block = "".join(html_lines[view_line-1:view_end])
        view_element_ids = re.findall(r'id=["\']([^"\']+)["\']', view_block)

    # Modal detection: from inventory table and index.html
    modal_candidates = set(re.findall(r'([a-zA-Z0-9_]*Modal)', html_lines_invent))
    for s in stems:
        for i, hline in enumerate(html_lines):
            mod_m = re.search(rf'id=["\']([a-zA-Z0-9_]*{re.escape(s)}[a-zA-Z0-9_]*Modal)["\']', hline, re.IGNORECASE)
            if mod_m:
                modal_candidates.add(mod_m.group(1))

    for modal in sorted(modal_candidates):
        for i, hline in enumerate(html_lines):
            if f'id="{modal}"' in hline or f"id='{modal}'" in hline:
                m_line = i + 1
                modal_lines[modal] = m_line
                m_end = len(html_lines)
                for j in range(m_line, len(html_lines)):
                    if 'class="modal-overlay' in html_lines[j] or ('<!--' in html_lines[j] and 'Modal' in html_lines[j]):
                        m_end = j
                        break
                m_block = "".join(html_lines[m_line-1:m_end])
                modal_element_ids[modal] = re.findall(r'id=["\']([^"\']+)["\']', m_block)
                break

legacy_html_parts = []
if view_line:
    legacy_html_parts.append(f"`#{view_id or ('view' + pascal_name)}` L{view_line}")
for modal, m_line in modal_lines.items():
    legacy_html_parts.append(f"`#{modal}` L{m_line}")

if legacy_html_parts:
    legacy_html_summary = ", ".join(legacy_html_parts)
else:
    legacy_html_summary = html_lines_invent

# Server routes scanning
with open(server_path, 'r', encoding='utf-8') as f:
    server_lines = f.readlines()

server_filename = os.path.basename(server_path)
routes = []
method_pattern = re.compile(r"req\.method\s*===\s*['\"]([A-Z]+)['\"]")
comment_pattern = re.compile(r"//\s*API:\s*(?:[A-Z]+\s+)?(/\S+)")
validation_pattern = re.compile(r"^\s*(if\s*\(!body\.[^)]+\)\s*\{?)")

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
                if cm and any(pref in cm.group(1) for pref in api_prefixes_from_app):
                    path = cm.group(1)
                    break
        if not path:
            eq_m = re.search(r"pathname\s*===\s*['\"]([^'\"]+)['\"]", line)
            if eq_m and any(pref in eq_m.group(1) for pref in api_prefixes_from_app):
                path = eq_m.group(1)
            else:
                sw_m = re.search(r"pathname\.startsWith\(['\"]([^'\"]+)['\"]\)", line)
                if sw_m and any(pref in sw_m.group(1) for pref in api_prefixes_from_app):
                    path = sw_m.group(1)
                    if path.endswith('/'):
                        path = path + ':id'
                    ew_m = re.search(r"pathname\.endsWith\(['\"]([^'\"]+)['\"]\)", line)
                    if ew_m:
                        path = path + ew_m.group(1)

        if not path:
            continue

        validation = None
        for fwd in range(1, 10):
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

legacy_elem_lines = []
if view_element_ids:
    v_ids_str = ", ".join(f"`#{eid}`" for eid in view_element_ids)
    legacy_elem_lines.append(f"     - View `#{view_id or ('view' + pascal_name)}` (index.html L{view_line}): {v_ids_str}")
for modal in sorted(modal_element_ids.keys()):
    m_ids = modal_element_ids[modal]
    m_line = modal_lines.get(modal, "")
    m_line_str = f"L{m_line}" if m_line else ""
    m_ids_str = ", ".join(f"`#{eid}`" for eid in m_ids)
    legacy_elem_lines.append(f"     - Modal `#{modal}` (index.html {m_line_str}): {m_ids_str}")
if not legacy_elem_lines:
    legacy_elem_lines.append("     - (None identified in index.html)")
legacy_elements_block = "\n".join(legacy_elem_lines)

note_section = f"\n\nRequirement: {what_missing}" if what_missing else ""

brief = f"""## Goal
Implement the {feature_title} view in the Preact shell for Phase 5 View Inventory Row {target_row}, with parity to legacy `packages/desktop/renderer/app.js` {legacy_app_summary} and `index.html` {legacy_html_summary}, verified in a real Electron window with zero horizontal overflow.{note_section}

## Scope
1. Files to create/modify (base: origin/main `{git_sha}`):
   - Server routes (verified in `packages/desktop/src/desktop-server.ts`, do not change them):
{routes_block}
   - Legacy elements to replicate (`index.html`):
{legacy_elements_block}
   - Create `packages/desktop/src/shell/{slug}-model.ts`:
     - Types, pure helpers, validation logic, and state machines for {slug}.
     - Unit tests in `packages/desktop/test/{slug}-model.test.ts` covering every helper.
   - Create `packages/desktop/renderer-next/src/data/{slug}.ts`:
     - Export `{pascal_name}Data` interface and `{slug}Data(bridge, http)` factory, following `data/skills.ts` (bridge-first, else HTTP fallback, `__test{pascal_name}` mock path).
   - `packages/desktop/renderer-next/src/data.ts`:
     - Add `& {pascal_name}Data` to the `ShellData` intersection and spread `...{slug}Data(bridge, http)` in `windowBridgeData()`. One line each.
   - Register view in `packages/desktop/renderer-next/src/views/registry.ts`:
     - One import and one line in `VIEW_COMPONENTS`. Do NOT edit `Shell.tsx`.
   - Create `packages/desktop/renderer-next/src/views/{pascal_name}View.tsx`:
     - Preact component taking `ViewProps` (`data`, `active`, `onSelect`, `refreshKey`).
     - View header, capabilities subnav with `{slug}` active, cards grid / controls matching legacy layout.
   - `packages/desktop/renderer-next/src/shell.css`:
     - Append rules in a `/* {slug} view */` block at the END of the file only; no horizontal overflow at 960x740 and 1920x1080.
   - Create `packages/desktop/test/{slug}-real-window.test.ts`:
     - Real Electron window test verifying UI states, modals, and layout at 960x740 and 1920x1080 with zero horizontal overflow.
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
1. `<{pascal_name}View />` renders with parity to the legacy view and its modals with zero horizontal overflow at 960x740 and 1920x1080.
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
}

BRIEF_CONTENT="$(generate_brief)"

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
