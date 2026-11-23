#!/usr/bin/env bash
# OpenSand check-engine-wrapper-sync: validates SHA-256 hashes of vendored engine wrapper files against PIN.
# Tier 1 (all environments / CI): checks vendored agent_wrap.mjs and engine_facts.mjs against committed PIN.
# Tier 2 (local machines with ~/SKILLS): if source exists, verifies source matches PIN (warns, or fails if --strict).
# --sync: copies source files into vendor dir and regenerates PIN.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT/packages/coordinator/src/engines/vendor"
PIN_FILE="$VENDOR_DIR/PIN"
SOURCE_DIR="${SOURCE_DIR:-$HOME/SKILLS/coding-agent-engines/scripts}"

FILES=("agent_wrap.mjs" "engine_facts.mjs")

sha256_file() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk "{print \$1}"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk "{print \$1}"
  else
    node -e 'const fs=require("fs"),crypto=require("crypto");console.log(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$f"
  fi
}

SYNC=0
STRICT=0

for arg in "$@"; do
  case "$arg" in
    --sync) SYNC=1 ;;
    --strict) STRICT=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$SYNC" -eq 1 ]]; then
  if [[ ! -d "$SOURCE_DIR" ]]; then
    echo "ERROR: Source directory not found: $SOURCE_DIR" >&2
    exit 1
  fi
  mkdir -p "$VENDOR_DIR"
  for f in "${FILES[@]}"; do
    if [[ ! -f "$SOURCE_DIR/$f" ]]; then
      echo "ERROR: Source file $SOURCE_DIR/$f does not exist!" >&2
      exit 1
    fi
    cp -p "$SOURCE_DIR/$f" "$VENDOR_DIR/$f"
  done
  SYNC_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  {
    echo "# OpenSand Vendored Coding-Agent Engine Wrapper Pin"
    echo "# Source: ~/SKILLS/coding-agent-engines/scripts"
    echo "# Synced: $SYNC_DATE"
    for f in "${FILES[@]}"; do
      echo "SHA256 ($f) = $(sha256_file "$VENDOR_DIR/$f")"
    done
  } > "$PIN_FILE"
  echo "Synced vendored files and updated $PIN_FILE"
  exit 0
fi

if [[ ! -f "$PIN_FILE" ]]; then
  echo "ERROR: PIN file not found: $PIN_FILE" >&2
  exit 1
fi

# Tier 1: Check vendored files against PIN
for f in "${FILES[@]}"; do
  vfile="$VENDOR_DIR/$f"
  if [[ ! -f "$vfile" ]]; then
    echo "ERROR: Vendored file missing: $vfile" >&2
    exit 1
  fi
  EXPECTED_SHA=$(grep "SHA256 ($f) = " "$PIN_FILE" | awk "{print \$4}")
  if [[ -z "$EXPECTED_SHA" ]]; then
    echo "ERROR: PIN file missing SHA entry for $f" >&2
    exit 1
  fi
  ACTUAL_SHA=$(sha256_file "$vfile")
  if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    echo "ERROR: Vendored file $f does not match PIN!" >&2
    echo "  Expected: $EXPECTED_SHA" >&2
    echo "  Actual:   $ACTUAL_SHA" >&2
    exit 1
  fi
done

echo "PASS: Vendored engine wrapper files match PIN."

# Tier 2: If source exists, compare against PIN
if [[ -d "$SOURCE_DIR" ]]; then
  DRIFT=0
  for f in "${FILES[@]}"; do
    sfile="$SOURCE_DIR/$f"
    if [[ -f "$sfile" ]]; then
      SRC_SHA=$(sha256_file "$sfile")
      EXPECTED_SHA=$(grep "SHA256 ($f) = " "$PIN_FILE" | awk "{print \$4}")
      if [[ "$SRC_SHA" != "$EXPECTED_SHA" ]]; then
        DRIFT=1
        echo "NOTICE: Source $sfile differs from vendored PIN!" >&2
      fi
    fi
  done
  if [[ "$DRIFT" -eq 1 ]]; then
    if [[ "$STRICT" -eq 1 ]]; then
      echo "ERROR: Source files drift from PIN in strict mode. Run: bash scripts/check-engine-wrapper-sync.sh --sync" >&2
      exit 1
    else
      echo "NOTICE: vendored copy in OpenSand is behind the source (~/SKILLS/coding-agent-engines/scripts). Run: bash scripts/check-engine-wrapper-sync.sh --sync"
    fi
  fi
fi

exit 0
