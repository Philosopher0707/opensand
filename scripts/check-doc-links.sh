#!/usr/bin/env bash
# Check that local markdown links under docs/ resolve to real files.
# External URLs, mailto:, and pure #anchors are ignored; fenced code is not scanned.
# Usage: scripts/check-doc-links.sh   (CHECK_DOC_LINKS_DIR overrides the docs dir)
# Exit 0 all local links resolve, 1 a broken link, 2 bad usage / missing python3.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_DIR="${CHECK_DOC_LINKS_DIR:-$ROOT/docs}"

command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required for the doc link check" >&2; exit 2; }
if [[ ! -d "$DOCS_DIR" ]]; then
  echo "FAIL: docs directory not found: $DOCS_DIR" >&2
  exit 2
fi

python3 - "$DOCS_DIR" <<'PY'
import pathlib
import re
import sys

docs = pathlib.Path(sys.argv[1]).resolve()
link_re = re.compile(r'!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
fence_re = re.compile(r'^\s*(```|~~~)')
broken = []
checked = 0

for md in sorted(docs.rglob('*.md')):
    in_fence = False
    for lineno, line in enumerate(md.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
        if fence_re.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for match in link_re.finditer(line):
            target = match.group(1)
            if target.startswith(('http://', 'https://', 'mailto:', '#')):
                continue
            base = target.split('#', 1)[0]
            if not base:
                continue
            checked += 1
            resolved = (md.parent / base).resolve()
            if not resolved.exists():
                broken.append((md, lineno, target))

for md, lineno, target in broken:
    print(f"FAIL: {md.relative_to(docs)}:{lineno}: broken link -> {target}")
if broken:
    print(f"FAIL: {len(broken)} broken doc link(s); {checked} local links checked.")
    sys.exit(1)
print(f"PASS: {checked} local doc links resolve under {docs}.")
PY
