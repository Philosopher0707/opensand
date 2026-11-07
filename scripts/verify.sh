#!/usr/bin/env bash
# One command to prove the tree is healthy: install, build, test.
# Usage: scripts/verify.sh   (SKIP_INSTALL=1 to reuse node_modules)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "verify: node 22+ is required" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "verify: pnpm 10 is required" >&2; exit 1; }

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  pnpm install --frozen-lockfile
fi

pnpm -r run build
pnpm -r run test

echo "verify: checking zero-test package guard..."
for pkg_json in packages/*/package.json; do
  [[ -f "$pkg_json" ]] || continue
  pkg_dir="$(dirname "$pkg_json")"
  ts_srcs=$(find "$pkg_dir/src" -name "*.ts" 2>/dev/null || true)
  if [[ -n "$ts_srcs" ]]; then
    pkg_name=$(node -p "require('./$pkg_json').name")
    output=$(pnpm --filter "$pkg_name" test 2>&1)
    # Node 26 prints "ℹ tests 39"; Node 22 (CI) prints "# tests 39".
    test_count=$(echo "$output" | grep -E "(#|ℹ) (tests|pass) [0-9]+" | awk '{print $NF}' | tail -n 1 || true)
    if [[ -z "$test_count" || "$test_count" -le 0 ]]; then
      echo "verify error: Package $pkg_name has TypeScript sources in src/ but reported 0 tests!" >&2
      exit 1
    fi
  fi
done

echo "verify: ok"
