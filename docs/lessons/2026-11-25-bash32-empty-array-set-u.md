# macOS Bash 3.2 aborts on an empty array under `set -u`, and CI tokens hide it

- **Trap:** `scripts/engine-smoke.sh` built `UNSET_ARGS=()` by scanning the
  environment for credential names, then launched the app with
  `env -u ELECTRON_RUN_AS_NODE "${UNSET_ARGS[@]}"`. In a clean environment no
  name matched, the array stayed empty, and macOS Bash 3.2 with `set -euo
  pipefail` failed with `UNSET_ARGS[@]: unbound variable` before the app was
  launched. PR #256's selftest passed everywhere because it ran under a newer
  Bash and because CI and developer shells carry `*_TOKEN` variables that make
  the array non-empty.
- **Root Cause:** Bash 3.2 treats `"${empty[@]}"` as an unset variable under
  `set -u`; Bash 4.4+ expands it to nothing. The only environment where the
  array is empty is the one the script exists to support: a user's clean shell.
- **Rule:** seed an argument array with a value that must always be present
  (`UNSET_ARGS=(-u ELECTRON_RUN_AS_NODE)`) instead of relying on additions, and
  test the launch path under `/bin/bash` with `env -i` (macOS's 3.2), never
  only under the developer's newer Bash. A green CI job that sets token
  variables cannot prove the clean case.
