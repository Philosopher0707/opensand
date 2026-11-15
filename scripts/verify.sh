#!/usr/bin/env bash
# One command to prove the tree is healthy: install, build, test.
# Usage: scripts/verify.sh   (SKIP_INSTALL=1 to reuse node_modules)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "verify: node 22+ is required" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "verify: pnpm 10 is required" >&2; exit 1; }

echo "verify: checking workspace package version consistency..."
node scripts/sync-versions.js --check

# Release tag guard: when in release context, ensure tag matches package version
RELEASE_TAG="${RELEASE_TAG:-}"
if [[ -z "${RELEASE_TAG:-}" ]]; then
  if [[ "${GITHUB_REF_TYPE:-}" == "tag" && -n "${GITHUB_REF_NAME:-}" ]]; then
    RELEASE_TAG="${GITHUB_REF_NAME}"
  elif [[ "${GITHUB_REF:-}" =~ ^refs/tags/(.*)$ ]]; then
    RELEASE_TAG="${BASH_REMATCH[1]}"
  elif [[ -n "${TAG:-}" ]]; then
    RELEASE_TAG="${TAG}"
  elif [[ "${RELEASE:-}" == "1" || "${RELEASE_CONTEXT:-}" == "1" ]]; then
    RELEASE_TAG=$(git describe --tags --exact-match 2>/dev/null || true)
    if [[ -z "$RELEASE_TAG" ]]; then
      echo "verify error: Release context requested but HEAD has no matching git tag!" >&2
      exit 1
    fi
  fi
fi

if [[ -n "$RELEASE_TAG" ]]; then
  echo "verify: checking release tag version against package.json ($RELEASE_TAG)..."
  ROOT_VERSION=$(node -p "require('./package.json').version")
  TAG_VERSION="${RELEASE_TAG#v}"
  if [[ "$TAG_VERSION" != "$ROOT_VERSION" ]]; then
    echo "verify error: Release tag '$RELEASE_TAG' (version '$TAG_VERSION') does not match root package.json version '$ROOT_VERSION'!" >&2
    echo "verify error: Packaging with this mismatch would produce mislabeled release artifacts (e.g. OpenSand-$ROOT_VERSION-arm64.dmg instead of OpenSand-$TAG_VERSION-arm64.dmg)." >&2
    echo "verify error: Run 'node scripts/sync-versions.js $TAG_VERSION' before cutting or packaging this release." >&2
    exit 1
  fi
  echo "verify: release tag '$RELEASE_TAG' matches package version '$ROOT_VERSION'"
fi

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  pnpm install --frozen-lockfile
fi

pnpm -r run build

# Each package's tests run once, with the output kept in a log. A failing package is named and its
# failing lines printed, instead of the script dying silently inside a command substitution.
# The zero-test guard reads the same logs rather than running the suites a second time.
LOG_DIR="${TMPDIR:-/tmp}/opensand-verify"
LOG_DIR="${LOG_DIR%/}"
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

for pkg_json in packages/*/package.json; do
  [[ -f "$pkg_json" ]] || continue
  pkg_dir="$(dirname "$pkg_json")"
  pkg_name=$(node -p "require('./$pkg_json').name")
  log="$LOG_DIR/${pkg_name//\//__}.log"

  # PIPESTATUS[0] is pnpm's own status; tee's would hide a failure. The "||" keeps set -e from
  # ending the script here, before the failure is reported.
  status=0
  pnpm --filter "$pkg_name" test 2>&1 | tee "$log" || status=${PIPESTATUS[0]}
  if [[ "$status" -ne 0 ]]; then
    echo "" >&2
    echo "verify error: Package $pkg_name failed its tests (exit $status). Failing lines:" >&2
    grep -E -m 5 -A 30 '^[[:space:]]*(✖|not ok)' "$log" >&2 || tail -n 30 "$log" >&2
    echo "verify error: Full output: $log" >&2
    exit 1
  fi

  echo "verify: checking zero-test package guard for $pkg_name..."
  ts_srcs=$(find "$pkg_dir/src" -name "*.ts" 2>/dev/null || true)
  if [[ -n "$ts_srcs" ]]; then
    # Node 26 prints "ℹ tests 39"; Node 22 (CI) prints "# tests 39".
    test_count=$(grep -E "(#|ℹ) (tests|pass) [0-9]+" "$log" | awk '{print $NF}' | tail -n 1 || true)
    if [[ -z "$test_count" || "$test_count" -le 0 ]]; then
      echo "verify error: Package $pkg_name has TypeScript sources in src/ but reported 0 tests!" >&2
      exit 1
    fi
  fi
done

echo "verify: ok"
