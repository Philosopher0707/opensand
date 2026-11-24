#!/usr/bin/env bash
# Git pre-push hook: scan only the commits each pushed ref introduces.
# Reads Git's <local ref> <local sha> <remote ref> <remote sha> protocol from stdin.
set -euo pipefail

# Git exports GIT_* to hooks. After changing to the invoking worktree, none may
# redirect a child git/gitleaks command into another repository.
while IFS='=' read -r name _; do
  case "$name" in
    GIT_*) unset "$name" ;;
  esac
done < <(env)

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$ROOT" ]]; then
  echo "x pre-push: not inside a git work tree; refusing to push unscanned commits." >&2
  exit 2
fi
cd "$ROOT"

GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
if ! version=$("$GITLEAKS_BIN" version 2>/dev/null); then
  echo "x pre-push: gitleaks is unavailable; install pinned version 8.30.1 or set GITLEAKS_BIN." >&2
  exit 2
fi
if [[ "$version" != "8.30.1" ]]; then
  echo "x pre-push: gitleaks 8.30.1 is required; found '$version'." >&2
  exit 2
fi

scanned=0
blocked=0
while read -r local_ref local_sha remote_ref remote_sha extra; do
  [[ -n "$local_ref" ]] || continue
  if [[ -z "$local_sha" || -z "$remote_ref" || -z "$remote_sha" || -n "$extra" ]] ||
     [[ ! "$local_sha" =~ ^[0-9a-fA-F]+$ || ! "$remote_sha" =~ ^[0-9a-fA-F]+$ ]] ||
     { [[ ${#local_sha} -ne 40 && ${#local_sha} -ne 64 ]] || [[ ${#remote_sha} -ne 40 && ${#remote_sha} -ne 64 ]]; }; then
    echo "x pre-push: malformed ref update for '$local_ref'; refusing to push." >&2
    exit 2
  fi

  # A deleted ref introduces no commits.
  [[ "$local_sha" =~ ^0+$ ]] && continue
  if ! git cat-file -e "${local_sha}^{commit}" 2>/dev/null; then
    echo "x pre-push: local commit for '$local_ref' is unavailable; refusing to push." >&2
    exit 2
  fi

  if [[ "$remote_sha" =~ ^0+$ ]]; then
    range="$local_sha"
  else
    if ! git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
      echo "x pre-push: remote base for '$local_ref' is unavailable; fetch it before pushing." >&2
      exit 2
    fi
    [[ "$local_sha" == "$remote_sha" ]] && continue
    range="${remote_sha}..${local_sha}"
  fi

  scanned=$((scanned + 1))
  echo "pre-push: scanning $local_ref ($range)"
  if output=$("$GITLEAKS_BIN" git --no-banner --redact --no-color --verbose \
    --config "$ROOT/.gitleaks.toml" --log-opts="$range" 2>&1); then
    echo "pre-push: clean ($local_ref)"
  else
    rc=$?
    if [[ "$rc" -eq 1 ]]; then
      printf '%s\n' "$output" >&2
      blocked=1
    else
      echo "x pre-push: gitleaks failed for '$local_ref' (exit $rc); refusing to push." >&2
      printf '%s\n' "$output" >&2
      exit 2
    fi
  fi
done

if [[ "$blocked" -ne 0 ]]; then
  echo "x pre-push: secret scan refused the push; candidate values are redacted." >&2
  exit 1
fi
if [[ "$scanned" -eq 0 ]]; then
  echo "pre-push: nothing to scan."
fi
echo "pre-push passed"
