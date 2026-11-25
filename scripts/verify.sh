#!/usr/bin/env bash
# One command to prove the tree is healthy: install, build, test.
# Usage: scripts/verify.sh   (SKIP_INSTALL=1 to reuse node_modules)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# PR change detection: on pull_request events, safely run only affected packages
# and skip untouched desktop real-window tests to speed up CI.
# Fail-closed rules:
# 1. Non-PR runs (e.g. push to main, workflow_dispatch, local default) run full suite.
# 2. Release tags (or release context) run full suite (never enter DOCS_ONLY skip).
# 3. VERIFY_ALL=1 forces full suite.
# 4. If BASE_SHA or git diff cannot be resolved or is empty, fail closed to full suite.
# 5. Core/shared packages, root configs, .github, scripts/verify*, check-* run full suite.
DOCS_ONLY=0
RUN_ALL_PACKAGES=0
BASE_SHA="${BASE_SHA:-}"
CHANGED=""

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
  RUN_ALL_PACKAGES=1
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

if [[ "${VERIFY_ALL:-0}" == "1" ]]; then
  RUN_ALL_PACKAGES=1
elif [[ -n "$RELEASE_TAG" ]]; then
  RUN_ALL_PACKAGES=1
elif [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  RUN_ALL_PACKAGES=1
else
  if [[ -z "$BASE_SHA" && -n "${GITHUB_EVENT_PATH:-}" && -f "${GITHUB_EVENT_PATH}" ]]; then
    BASE_SHA=$(node -e 'const e=require(process.argv[1]);process.stdout.write((e.pull_request&&e.pull_request.base&&e.pull_request.base.sha)||"")' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  fi

  if [[ -z "$BASE_SHA" ]]; then
    RUN_ALL_PACKAGES=1
  else
    git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null || git fetch -q --no-tags --depth=1 origin "$BASE_SHA" 2>/dev/null || true
    if ! git rev-parse --verify "${BASE_SHA}^{commit}" >/dev/null 2>&1; then
      RUN_ALL_PACKAGES=1
    else
      CHANGED=$(git diff --name-only --no-renames "$BASE_SHA" HEAD 2>/dev/null || true)
      if [[ -z "$CHANGED" ]]; then
        RUN_ALL_PACKAGES=1
      fi
    fi
  fi
fi

# Only non-release pull_request runs may enter docs-only early skip
if [[ "$RUN_ALL_PACKAGES" -eq 0 && -z "$RELEASE_TAG" && -n "$CHANGED" ]]; then
  DOCS_ONLY=1
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if ! [[ "$path" == docs/* || "$path" == *.md || "$path" == LICENSE* || "$path" == NOTICE* ]]; then
      DOCS_ONLY=0
      break
    fi
  done <<< "$CHANGED"
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

echo "verify: checking generated lessons-index rebase merge..."
bash scripts/lessons-index-merge-selftest.sh

echo "verify: checking real-window navigation helper..."
bash scripts/check-real-window-nav.sh

echo "verify: checking hidden-window Electron spawn helper..."
bash scripts/check-hidden-window-spawns.sh

echo "verify: checking desktop test teardown helper..."
bash scripts/check-test-teardown.sh

echo "verify: checking vendored engine wrapper sync..."
bash scripts/check-engine-wrapper-sync.sh

echo "verify: checking test tmpdir guard..."
BAD_TMPDIRS=$(grep -rnE --include="*.ts" --include="*.js" "(/tmp/opensand-|(/tmp|tmpdir).*Date\\.now|Date\\.now.*(/tmp|tmpdir)|mkdir.*(os\\.tmpdir|/tmp))" packages/*/test 2>/dev/null || true)
if [[ -n "$BAD_TMPDIRS" ]]; then
  echo "verify error: Test fixtures must use approved tempDir() or mkdtemp helpers, never un-isolated temp paths or timestamps (rule 12.3):" >&2
  echo "$BAD_TMPDIRS" >&2
  exit 1
fi

if [[ "${SKIP_INSTALL:-}" != "1" ]]; then
  pnpm install --frozen-lockfile
fi

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

TARGET_PACKAGES=()
SCRIPT_SELFTESTS=()

if [[ "$RUN_ALL_PACKAGES" -eq 0 && -n "$CHANGED" ]]; then
  EVAL_RESULT=$(node -e '
    const fs = require("fs");
    const path = require("path");

    const rootDir = process.cwd();
    const changed = process.argv[1].split("\n").map(s => s.trim()).filter(Boolean);

    const pkgsDir = path.join(rootDir, "packages");
    const pkgDirs = new Set();
    const nameToDir = {};
    const dirToName = {};

    if (fs.existsSync(pkgsDir)) {
      for (const d of fs.readdirSync(pkgsDir)) {
        const pjson = path.join(pkgsDir, d, "package.json");
        if (fs.existsSync(pjson)) {
          pkgDirs.add(d);
          try {
            const j = JSON.parse(fs.readFileSync(pjson, "utf8"));
            if (j.name) {
              nameToDir[j.name] = d;
              dirToName[d] = j.name;
            }
          } catch {}
        }
      }
    }

    const changedPackages = new Set();
    const selftests = new Set();
    let forceAll = false;
    let reason = "";

    for (const f of changed) {
      if (f.startsWith("docs/") || f.endsWith(".md") || f.startsWith("LICENSE") || f.startsWith("NOTICE")) {
        continue;
      }
      if (
        f === "package.json" ||
        f === "pnpm-lock.yaml" ||
        f === "pnpm-workspace.yaml" ||
        f.startsWith("tsconfig") ||
        f.startsWith(".github/") ||
        f.startsWith("scripts/verify") ||
        f.startsWith("scripts/check-") ||
        f.startsWith("scripts/release")
      ) {
        forceAll = true;
        reason = "shared dependency or gate changed: " + f;
        break;
      }
      if (
        f.startsWith("packages/shared/") ||
        f.startsWith("packages/protocol/") ||
        f.startsWith("packages/desktop/") ||
        f.startsWith("packages/native-bridge/")
      ) {
        forceAll = true;
        reason = "core/shared package changed: " + f;
        break;
      }
      if (f.startsWith("packages/")) {
        const parts = f.split("/");
        const pkg = parts[1];
        if (pkgDirs.has(pkg)) {
          changedPackages.add(pkg);
          continue;
        } else {
          forceAll = true;
          reason = "unknown package: " + f;
          break;
        }
      }
      if (f.startsWith("scripts/")) {
        const parts = f.split("/");
        const scriptFile = parts[1];
        let selftestPath = null;
        if (scriptFile.endsWith("-selftest.sh") || scriptFile.endsWith("-selftest.js")) {
          selftestPath = path.join("scripts", scriptFile);
        } else {
          const base = scriptFile.replace(/\.(sh|js|ts|bash|zsh)$/, "");
          const candidateSh = path.join("scripts", base + "-selftest.sh");
          const candidateJs = path.join("scripts", base + "-selftest.js");
          if (fs.existsSync(path.join(rootDir, candidateSh))) {
            selftestPath = candidateSh;
          } else if (fs.existsSync(path.join(rootDir, candidateJs))) {
            selftestPath = candidateJs;
          }
        }
        if (selftestPath && fs.existsSync(path.join(rootDir, selftestPath))) {
          selftests.add(selftestPath);
          continue;
        } else {
          forceAll = true;
          reason = "script without selftest: " + f;
          break;
        }
      }
      forceAll = true;
      reason = "unknown diff path: " + f;
      break;
    }

    if (forceAll) {
      process.stdout.write(JSON.stringify({ mode: "ALL", reason }));
      process.exit(0);
    }

    const affected = new Set(changedPackages);
    if (changedPackages.size > 0) {
      const queue = [...changedPackages];
      while (queue.length > 0) {
        const curr = queue.shift();
        const currPkgName = dirToName[curr];
        for (const p of pkgDirs) {
          if (affected.has(p)) continue;
          const pjsonPath = path.join(pkgsDir, p, "package.json");
          try {
            const j = JSON.parse(fs.readFileSync(pjsonPath, "utf8"));
            const allDeps = Object.assign({}, j.dependencies, j.devDependencies);
            if ((currPkgName && allDeps[currPkgName]) || allDeps["@opensand/" + curr]) {
              affected.add(p);
              queue.push(p);
            }
          } catch {}
        }
      }
    }

    if (!changedPackages.has("desktop")) {
      affected.delete("desktop");
    }

    const targetPkgNames = [...affected].map(d => dirToName[d] || d).filter(Boolean);
    process.stdout.write(JSON.stringify({
      mode: "AFFECTED",
      packages: targetPkgNames,
      selftests: [...selftests]
    }));
  ' "$CHANGED")

  EVAL_MODE=$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.mode||"ALL")' "$EVAL_RESULT")
  if [[ "$EVAL_MODE" == "ALL" ]]; then
    RUN_ALL_PACKAGES=1
    EVAL_REASON=$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.reason||"")' "$EVAL_RESULT")
    echo "verify: running full suite ($EVAL_REASON)"
  else
    while IFS= read -r -d $'\0' pkg; do
      [[ -n "$pkg" ]] && TARGET_PACKAGES+=("$pkg")
    done < <(node -e 'const r=JSON.parse(process.argv[1]);for(const p of(r.packages||[])){process.stdout.write(p+"\0");}' "$EVAL_RESULT")

    while IFS= read -r -d $'\0' st; do
      [[ -n "$st" ]] && SCRIPT_SELFTESTS+=("$st")
    done < <(node -e 'const r=JSON.parse(process.argv[1]);for(const s of(r.selftests||[])){process.stdout.write(s+"\0");}' "$EVAL_RESULT")

    echo "verify: running affected packages only: ${TARGET_PACKAGES[*]:-}"
  fi
fi

if [[ ${#SCRIPT_SELFTESTS[@]} -gt 0 ]]; then
  for selftest in "${SCRIPT_SELFTESTS[@]}"; do
    [[ -n "$selftest" ]] || continue
    echo "verify: running script selftest $selftest..."
    if [[ "$selftest" == *.js ]]; then
      node "$selftest"
    else
      bash "$selftest"
    fi
  done
fi

LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opensand-verify.XXXXXX")

is_target_package() {
  local needle="$1"
  if [[ "$RUN_ALL_PACKAGES" -eq 1 ]]; then
    return 0
  fi
  for p in "${TARGET_PACKAGES[@]:-}"; do
    if [[ "$p" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

for pkg_json in packages/*/package.json; do
  [[ -f "$pkg_json" ]] || continue
  pkg_dir="$(dirname "$pkg_json")"
  pkg_name=$(node -p "require('./$pkg_json').name")
  log="$LOG_DIR/${pkg_name//\//__}.log"

  if ! is_target_package "$pkg_name"; then
    echo "verify: skipping package $pkg_name (untouched and unaffected)"
    continue
  fi

  echo "verify: testing package $pkg_name..."
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
