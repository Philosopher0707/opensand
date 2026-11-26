#!/usr/bin/env bash
# Release Gate Check: verifies repository integrity and executes packaged app smoke test
# Usage:
#   scripts/release-check.sh [path/to/OpenSand.zip]
#   scripts/release-check.sh --preflight <version>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export TMPDIR="${TMPDIR:-$(mktemp -d)}"

if [[ "${1:-}" == "--preflight" ]]; then
  VERSION="${2:-}"
  VERSION="${VERSION#v}"
  if [[ -z "${2:-}" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "release-check: usage: $0 --preflight <version>" >&2
    exit 2
  fi
  if [[ $# -ne 2 ]]; then
    echo "release-check: unexpected preflight argument: ${3:-}" >&2
    exit 2
  fi
  node "$REPO_ROOT/scripts/sync-versions.js" --check "$VERSION"
  if ! STATUS=$(git status --porcelain); then
    echo "release-check: could not inspect the working tree with git status" >&2
    exit 1
  fi
  if [[ -n "$STATUS" ]]; then
    echo "release-check: working tree has uncommitted changes" >&2
    exit 1
  fi
  echo "release-check: release version $VERSION is synchronized and the working tree is clean."
  exit 0
fi

if [[ "${1:-}" == "--verify-info-plist" ]]; then
  VERSION="${2:-}"
  VERSION="${VERSION#v}"
  PLIST="${3:-}"
  if [[ -z "${2:-}" || -z "$PLIST" || $# -ne 3 || ! -f "$PLIST" ]]; then
    echo "release-check: usage: $0 --verify-info-plist <version> <Info.plist>" >&2
    exit 2
  fi
  read_plist_value() {
    local key="$1"
    if [[ -x /usr/libexec/PlistBuddy ]]; then
      /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" 2>/dev/null && return
    fi
    node -e '
      const fs = require("node:fs");
      const xml = fs.readFileSync(process.argv[1], "utf8");
      const key = process.argv[2];
      const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(xml);
      if (!match) process.exit(1);
      process.stdout.write(match[1].trim());
    ' "$PLIST" "$key"
  }
  SHORT_VERSION=$(read_plist_value CFBundleShortVersionString)
  BUILD_VERSION=$(read_plist_value CFBundleVersion)
  if [[ "$SHORT_VERSION" != "$VERSION" || "$BUILD_VERSION" != "$VERSION" ]]; then
    echo "release-check: Info.plist mismatch: CFBundleShortVersionString='$SHORT_VERSION', CFBundleVersion='$BUILD_VERSION', expected '$VERSION'" >&2
    exit 1
  fi
  echo "release-check: Info.plist versions match $VERSION."
  exit 0
fi

if [[ "${1:-}" == "--verify-main-ci" ]]; then
  TAG_COMMIT="${2:-}"
  MAIN_REF="${3:-}"
  CI_RUN_ID="${4:-}"
  if [[ -z "$TAG_COMMIT" || -z "$MAIN_REF" || $# -ne 4 ]]; then
    echo "release-check: usage: $0 --verify-main-ci <tag-commit> <main-ref> <successful-ci-run-id>" >&2
    exit 2
  fi
  if ! git merge-base --is-ancestor "$TAG_COMMIT" "$MAIN_REF"; then
    echo "release-check: tag commit $TAG_COMMIT is not reachable from $MAIN_REF; refusing release." >&2
    exit 1
  fi
  if [[ ! "$CI_RUN_ID" =~ ^[0-9]+$ ]]; then
    echo "release-check: no successful push CI run exists for tag commit $TAG_COMMIT on main." >&2
    exit 1
  fi
  echo "release-check: tag commit is on main and successful CI run $CI_RUN_ID is present."
  exit 0
fi

if [[ "${1:-}" == "--verify-checksums" ]]; then
  ARTIFACT_DIR="${2:-}"
  PLATFORM="${3:-}"
  if [[ -z "$ARTIFACT_DIR" || $# -ne 3 || ! -f "$ARTIFACT_DIR/SHA256SUMS.txt" ]]; then
    echo "release-check: usage: $0 --verify-checksums <artifact-directory> <mac|linux> (SHA256SUMS.txt required)" >&2
    exit 2
  fi
  shopt -s nullglob
  case "$PLATFORM" in
    mac)
      ARTIFACTS=("$ARTIFACT_DIR"/*.dmg "$ARTIFACT_DIR"/*.zip)
      DMGS=("$ARTIFACT_DIR"/*.dmg)
      ZIPS=("$ARTIFACT_DIR"/*.zip)
      [[ ${#DMGS[@]} -gt 0 && ${#ZIPS[@]} -gt 0 ]] || {
        echo "release-check: macOS release requires at least one .dmg and one .zip." >&2
        exit 1
      }
      ;;
    linux)
      ARTIFACTS=("$ARTIFACT_DIR"/*.AppImage "$ARTIFACT_DIR"/*.deb)
      APPIMAGES=("$ARTIFACT_DIR"/*.AppImage)
      DEBS=("$ARTIFACT_DIR"/*.deb)
      [[ ${#APPIMAGES[@]} -gt 0 && ${#DEBS[@]} -gt 0 ]] || {
        echo "release-check: Linux release requires at least one .AppImage and one .deb." >&2
        exit 1
      }
      ;;
    *)
      echo "release-check: platform must be 'mac' or 'linux'." >&2
      exit 2
      ;;
  esac
  ARTIFACT_NAMES=("${ARTIFACTS[@]##*/}")
  EXPECTED_MANIFEST=$(cd "$ARTIFACT_DIR" && shasum -a 256 "${ARTIFACT_NAMES[@]}" | LC_ALL=C sort)
  ACTUAL_MANIFEST=$(LC_ALL=C sort "$ARTIFACT_DIR/SHA256SUMS.txt")
  if [[ "$ACTUAL_MANIFEST" != "$EXPECTED_MANIFEST" ]]; then
    echo "release-check: SHA256SUMS.txt must cover exactly every $PLATFORM release asset." >&2
    exit 1
  fi
  (cd "$ARTIFACT_DIR" && shasum -a 256 -c SHA256SUMS.txt)
  exit 0
fi

echo "release-check: running workspace verification suite..."
SKIP_INSTALL=1 bash "$REPO_ROOT/scripts/verify.sh"

echo "release-check: running packaged app smoke verification..."
bash "$REPO_ROOT/scripts/smoke-packaged.sh" "${1:-}"

echo "release-check: all pre-release gates passed."
