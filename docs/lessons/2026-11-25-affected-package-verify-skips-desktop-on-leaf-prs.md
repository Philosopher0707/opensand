# Affected-package CI verification: fail-closed safety with desktop real-window skip

**Trap:** Every docs, script, or leaf package PR previously ran the entire macOS Electron real-window test suite in CI (7-12 minutes), even when changed code could not affect Electron windows. Naively skipping packages risks shipping broken dependencies if reverse dependents or core contracts change.

**Root Cause:** CI verify ran an unconditional loop over all packages. Because `packages/desktop` depends on lower-level packages like coordinator and engine, tests for leaf packages ran alongside the expensive window suite on every PR, while main merges and release tags need full regression coverage.

**Rule:** On `pull_request` events, filter packages to directly changed leaf packages plus their reverse workspace dependents while skipping untouched `packages/desktop` real-window tests; run matching script selftests for script-only changes. Fail closed to 100% of packages on `push` to `main`, release tags, `VERIFY_ALL=1`, missing base commit, unknown diffs, or changes to core/shared packages (`packages/shared`, `packages/protocol`, `packages/desktop`, `packages/native-bridge`, root configs, `.github/`, `scripts/verify*`, `scripts/check-*`). [checked: `scripts/verify-selftest.sh`, `scripts/proof-red-green.sh`]
