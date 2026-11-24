#!/usr/bin/env bash
# One command to prove the tree is healthy: install, build, test.
# Usage: scripts/verify.sh   (SKIP_INSTALL=1 to reuse node_modules)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Docs-only PRs skip the build and test suites below; the CI job still runs and reports success,
# so the required check names stay green. The cheap repo checks in this script always run.
# Fail-closed: if the base commit cannot be resolved, DOCS_ONLY stays 0 and the full suite runs.
DOCS_ONLY=0
if [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
  BASE_SHA=$(node -e 'const e=require(process.argv[1]);process.stdout.write((e.pull_request&&e.pull_request.base&&e.pull_request.base.sha)||"")' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  if [[ -n "$BASE_SHA" ]]; then
    git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null || git fetch -q --no-tags --depth=1 origin "$BASE_SHA" 2>/dev/null || true
    CHANGED=$(git diff --name-only "$BASE_SHA" HEAD 2>/dev/null || true)
    if [[ -n "$CHANGED" ]]; then
      DOCS_ONLY=1
      while IFS= read -r path; do
        [[ "$path" == docs/* || "$path" == *.md || "$path" == LICENSE* || "$path" == NOTICE* ]] || DOCS_ONLY=0
      done <<< "$CHANGED"
    fi
  fi
fi

command -v node >/dev/null 2>&1 || { echo "verify: node 22+ is required" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "verify: pnpm 10 is required" >&2; exit 1; }

echo "verify: checking workspace package version consistency..."
node scripts/sync-versions.js --check

echo "verify: checking scripts catalog completeness..."
bash scripts/check-scripts-catalog.sh

echo "verify: checking bot brief template shape..."
bash scripts/lint-brief.sh docs/brief-template.md

echo "verify: checking docs links..."
bash scripts/check-doc-links.sh

echo "verify: checking lessons index is up to date..."
bash scripts/lessons-index.sh --check

echo "verify: checking real-window navigation helper..."
bash scripts/check-real-window-nav.sh

echo "verify: checking hidden-window Electron spawn helper..."
bash scripts/check-hidden-window-spawns.sh

echo "verify: checking vendored engine wrapper sync..."
bash scripts/check-engine-wrapper-sync.sh

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


echo "verify: checking test tmpdir guard..."
# Guard against test fixtures creating temp dirs/files outside approved helper patterns (AGENTS_LEARNING.md rule 12.3).
# Tests must use isolated unique directories via fs.mkdtemp/fs.mkdtempSync or package helpers (e.g. tempDir()),
# never bare timestamps (Date.now()) or static /tmp paths that collide under concurrency.
BAD_TMPDIRS=$(grep -rnE --include="*.ts" --include="*.js" "(/tmp/opensand-|(/tmp|tmpdir).*Date\\.now|Date\\.now.*(/tmp|tmpdir)|mkdir.*(os\\.tmpdir|/tmp))" packages/*/test 2>/dev/null || true)
if [[ -n "$BAD_TMPDIRS" ]]; then
  echo "verify error: Test fixtures must use approved tempDir() or mkdtemp helpers, never un-isolated temp paths or timestamps (rule 12.3):" >&2
  echo "$BAD_TMPDIRS" >&2
  exit 1
fi

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  pnpm install --frozen-lockfile
fi

# These two gates catch "small things left out": an error formatter nobody calls, and a raw
# provider/OS error sent to the user. They run after install because the dead-export check
# uses the repo's TypeScript compiler; both keep allowlists of today's findings and fail only
# on new ones (selftests: check-dead-exports-selftest.sh, check-raw-errors-selftest.sh).
echo "verify: checking for dead exports..."
bash scripts/check-dead-exports.sh

echo "verify: checking for raw errors reaching the user..."
bash scripts/check-raw-errors.sh

if [[ "$DOCS_ONLY" -eq 1 ]]; then
  echo "verify: docs-only change; skipping build and tests (repo checks above still ran)"
  exit 0
fi

pnpm -r run build

# --- Shared git config core.bare guard (before tests) -----------------
echo "verify: snapshotting git common config core.bare..."
COMMON_GIT_DIR="$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir 2>/dev/null || true)"
COMMON_CONFIG=""
BEFORE_CORE_BARE=""
if [[ -n "$COMMON_GIT_DIR" && -d "$COMMON_GIT_DIR" ]]; then
  COMMON_CONFIG="$COMMON_GIT_DIR/config"
  if [[ -f "$COMMON_CONFIG" ]]; then
    BEFORE_CORE_BARE="$(git config --file "$COMMON_CONFIG" core.bare 2>/dev/null || echo "unset")"
  fi
fi

# Each package's tests run once, with the output kept in a log. A failing package is named and its
# failing lines printed, instead of the script dying silently inside a command substitution.
# The zero-test guard reads the same logs rather than running the suites a second time.
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-verify.XXXXXX")

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
    echo "verify error: Log directory: $LOG_DIR" >&2
    echo "verify error: Full output: $log" >&2
    exit 1
  fi

  echo "verify: checking zero-test package guard for $pkg_name..."
  ts_srcs=$(find "$pkg_dir/src" -name "*.ts" 2>/dev/null || true)
  if [[ -n "$ts_srcs" ]]; then
    # Node 26 prints "ℹ tests 39"; Node 22 (CI) prints "# tests 39". A multi-phase runner's last
    # phase can be all skipped ("# pass 0" on Linux, where real-window tests have no display),
    # so take the largest count rather than the last one or a healthy package reads as zero.
    test_count=$(grep -E "(#|ℹ) (tests|pass) [0-9]+" "$log" | awk '{print $NF}' | sort -nr | head -n 1 || true)
    if [[ -z "$test_count" || "$test_count" -le 0 ]]; then
      echo "verify error: Package $pkg_name has TypeScript sources in src/ but reported 0 tests!" >&2
      echo "verify error: Log directory: $LOG_DIR" >&2
      echo "verify error: Full output: $log" >&2
      exit 1
    fi
  fi
done

# --- Shared git config core.bare guard (after tests) ------------------
if [[ -n "$COMMON_CONFIG" && -f "$COMMON_CONFIG" ]]; then
  AFTER_CORE_BARE="$(git config --file "$COMMON_CONFIG" core.bare 2>/dev/null || echo "unset")"
  if [[ "$BEFORE_CORE_BARE" != "$AFTER_CORE_BARE" || "$AFTER_CORE_BARE" == "true" ]]; then
    echo "verify error: Test run modified repository git config ($COMMON_CONFIG)!" >&2
    echo "  core.bare before: $BEFORE_CORE_BARE" >&2
    echo "  core.bare after:  $AFTER_CORE_BARE" >&2
    exit 1
  fi
  echo "verify: git config core.bare preserved ($AFTER_CORE_BARE)"
fi

echo "verify: ok"
