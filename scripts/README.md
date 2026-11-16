# OpenSand Scripts Catalog

This directory contains repository automation, gatekeepers, benchmarks, build utilities, and release tools.

All scripts in this directory are cataloged below. Automated verification is enforced by `scripts/check-scripts-catalog.sh` (wired into `scripts/verify.sh`).

---

## Catalog Index

| Script | Purpose | Trigger / Caller | Selftest |
| :--- | :--- | :--- | :--- |
| `bench-cold-start.ts` | Benchmark daemon startup latency | Manual performance testing | None |
| `bench-first-token.ts` | Benchmark engine model time-to-first-token | Manual performance testing | None |
| `check-scripts-catalog.sh` | Validate completeness of `scripts/README.md` and selftests | `scripts/verify.sh`, CI | `check-scripts-catalog-selftest.sh` |
| `check-scripts-catalog-selftest.sh` | Hermetic selftest for scripts catalog checker | Pre-commit / verification | Self |
| `clean-disk.sh` | Safe disk reclamation of merged/clean scratch worktrees and caches | Manual / low disk space in release | `clean-disk-selftest.sh` |
| `clean-disk-selftest.sh` | Hermetic selftest for disk cleanup script | Pre-commit / verification | Self |
| `mutate.sh` | Apply single-line mutation to verify test fails, restoring file in trap | Automated job proof / mutation testing | `proof-selftest.sh` |
| `opensand-completion.bash` | Bash tab completion definitions | User shell environment | None |
| `opensand-completion.zsh` | Zsh tab completion definitions | User shell environment | None |
| `opensand-desktop.sh` | Helper script to launch OpenSand desktop in development | Manual local development | None |
| `package-cli.sh` | Package standalone CLI executables and archives | Release workflows / CI | None |
| `proof-red-green.sh` | Prove test fails on base ref and passes on HEAD | Automated job proof / CI / pre-PR | `proof-selftest.sh` |
| `proof-report.sh` | Generate markdown proof report with PR metadata, diff hunks, CI IDs, red-green, and mutation logs | Automated job proof / PR review | `proof-selftest.sh` |
| `proof-selftest.sh` | Hermetic selftest suite for proof-red-green, mutate, and proof-report scripts | Pre-commit / verification | Self |
| `pr-gate.sh` | 5-step automated pre-merge verification and checkpoint gate | Pre-merge review workflow | `pr-gate-selftest.sh` |
| `pr-gate-selftest.sh` | Hermetic selftest for PR gate script | Pre-commit / verification | Self |
| `pre-commit.sh` | Git pre-commit hook enforcing blanket-add guard and test suite | Git pre-commit hook | None (tested by verify) |
| `provenance-gate.sh` | Build artifact provenance and digest verification gate | Release workflows / CI | None |
| `release.sh` | 8-step end-to-end automated release pipeline | Release Engineer / CI | `release-selftest.sh` |
| `release-check.sh` | Full release verification and smoke test gate | Pre-release sanity gate | None |
| `release-selftest.sh` | Hermetic selftest for automated release pipeline | Pre-commit / verification | Self |
| `smoke-packaged.sh` | Packaged application launch verification in isolated state | CI / release smoke gate | None |
| `sync-versions.js` | Synchronize and check version strings across workspace packages | `verify.sh`, release.sh | None (checked by verify) |
| `v1-dry-run.sh` | Validate v1 packaging and DMG generation pipeline | Manual release validation | None |
| `verify-linux.sh` | Run verification suite inside isolated Linux container | Local pre-CI cross-platform test | None |
| `verify-selftest.sh` | Hermetic selftest for verify.sh guardrails | Verification test suite | Self |
| `verify.sh` | Core repository verification gate (versions, build, tests, tripwires) | CI, pre-commit, manual | `verify-selftest.sh` |
| `worktree.sh` | OpenSand automated worktree lifecycle manager (new, review, done, list, prune) | Developer, bots, release automation | `worktree-selftest.sh` |
| `worktree-selftest.sh` | Hermetic selftest suite for worktree lifecycle manager | Pre-commit / verification | Self |

---

## Detailed Specifications

### `bench-cold-start.ts`
- **Purpose**: Measure cold startup time of the local daemon process.
- **Usage**: `node --loader tsx scripts/bench-cold-start.ts`
- **Exit Codes**: `0` on success, `1` on error.
- **Selftest**: None.
- **Trigger**: Manual benchmarking.

### `bench-first-token.ts`
- **Purpose**: Measure inference latency to the first token emitted by engine models.
- **Usage**: `node --loader tsx scripts/bench-first-token.ts`
- **Exit Codes**: `0` on success, `1` on error.
- **Selftest**: None.
- **Trigger**: Manual benchmarking.

### `check-scripts-catalog.sh`
- **Purpose**: Ensure all scripts in `scripts/` are documented in `README.md`, no nonexistent scripts are cataloged, and all gate/release scripts have selftests.
- **Usage**: `scripts/check-scripts-catalog.sh`
- **Exit Codes**: `0` on success, `1` on missing or invalid catalog entry.
- **Selftest**: `scripts/check-scripts-catalog-selftest.sh`.
- **Trigger**: `scripts/verify.sh`, CI.

### `check-scripts-catalog-selftest.sh`
- **Purpose**: Hermetic selftest suite validating all failure and pass modes of `check-scripts-catalog.sh`.
- **Usage**: `scripts/check-scripts-catalog-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `clean-disk.sh`
- **Purpose**: Safely reclaim disk space by removing `node_modules` and `dist` from clean, merged scratch worktrees and user caches.
- **Usage**: `scripts/clean-disk.sh [--yes]`
- **Exit Codes**: `0` on success, `1` on invalid arguments.
- **Selftest**: `scripts/clean-disk-selftest.sh`.
- **Trigger**: Manual invocation or automated via `scripts/release.sh` when free disk space is under 8 GB.

### `clean-disk-selftest.sh`
- **Purpose**: Hermetic selftest suite for `clean-disk.sh` using isolated git repos to ensure dirty and unmerged worktrees are never cleaned.
- **Usage**: `scripts/clean-disk-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `mutate.sh`
- **Purpose**: Apply a single-line replacement to a file, execute a test command, and verify the test fails under mutation while restoring the original file byte-identically even on interruption (SIGINT/SIGTERM/SIGHUP).
- **Usage**: `scripts/mutate.sh <file> <line> <replacement> -- <test command>`
- **Exit Codes**: `0` on test caught mutation (failed as expected), `1` on test passed despite mutation, `2` on mutation/restore/syntax error.
- **Selftest**: `scripts/proof-selftest.sh`.
- **Trigger**: Automated job proof, mutation testing.

### `opensand-completion.bash`
- **Purpose**: Programmable command line completion for bash users.
- **Usage**: `source scripts/opensand-completion.bash`
- **Exit Codes**: `0` on load.
- **Selftest**: None.
- **Trigger**: Sourced in shell environment.

### `opensand-completion.zsh`
- **Purpose**: Programmable command line completion for zsh users.
- **Usage**: `source scripts/opensand-completion.zsh`
- **Exit Codes**: `0` on load.
- **Selftest**: None.
- **Trigger**: Sourced in shell environment.

### `opensand-desktop.sh`
- **Purpose**: Launch helper for running the OpenSand desktop application under development mode.
- **Usage**: `scripts/opensand-desktop.sh`
- **Exit Codes**: Propagates Electron application exit status.
- **Selftest**: None.
- **Trigger**: Manual development.

### `package-cli.sh`
- **Purpose**: Build and bundle the CLI package into distribution tarballs.
- **Usage**: `scripts/package-cli.sh`
- **Exit Codes**: `0` on success, `1` on build failure.
- **Selftest**: None.
- **Trigger**: Release CI workflows.

### `proof-red-green.sh`
- **Purpose**: Verify red-green test cycle by executing a test file against a base ref (isolated temporary worktree) and against current HEAD, proving the test fails on base and passes on HEAD.
- **Usage**: `scripts/proof-red-green.sh <test-file> [--base <ref>] [-- <test-args...>]`
- **Exit Codes**: `0` on base fail & HEAD pass, `1` on validation or test status failure.
- **Selftest**: `scripts/proof-selftest.sh`.
- **Trigger**: Automated job proof, pre-PR verification.

### `proof-report.sh`
- **Purpose**: Assemble an automated Markdown proof report for a GitHub PR including metadata, diff hunks with line ranges, commit SHA, CI run IDs and conclusions, and embedded red-green/mutation logs.
- **Usage**: `scripts/proof-report.sh <PR-number> [--red-green <file>] [--mutate <file>]`
- **Exit Codes**: `0` on success, `1` on error.
- **Selftest**: `scripts/proof-selftest.sh`.
- **Trigger**: Automated job proof, PR verification report.

### `proof-selftest.sh`
- **Purpose**: Hermetic selftest suite verifying all pass and failure modes of `proof-red-green.sh`, `mutate.sh`, and `proof-report.sh` using a throwaway git repository.
- **Usage**: `scripts/proof-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification (`verify-selftest.sh`).

### `pr-gate.sh`
- **Purpose**: 5-step automated pre-merge verification gate: CI rollup check, base freshness, diff hygiene, checkpoint tag creation/remote verification, and merge.
- **Usage**: `scripts/pr-gate.sh [--allow-lockfile] [--allow-binary] [--dry-run] <PR-number>`
- **Exit Codes**: `0` on success, `1` on validation failure, `3` on pending CI.
- **Selftest**: `scripts/pr-gate-selftest.sh`.
- **Trigger**: Pre-merge workflow.

### `pr-gate-selftest.sh`
- **Purpose**: Hermetic selftest suite for `pr-gate.sh` stubbing `gh` and `git` commands.
- **Usage**: `scripts/pr-gate-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `pre-commit.sh`
- **Purpose**: Git pre-commit guard blocking blanket additions, unsetting git environment variables, executing builds/tests, and verifying git config tripwires.
- **Usage**: Executed by `.githooks/pre-commit` or manually via `scripts/pre-commit.sh`.
- **Exit Codes**: `0` on success, `1` on violation or failure.
- **Selftest**: None.
- **Trigger**: Git pre-commit hook.

### `provenance-gate.sh`
- **Purpose**: Verify artifact commit provenance against git metadata.
- **Usage**: `scripts/provenance-gate.sh <artifact>`
- **Exit Codes**: `0` on verified, `1` on mismatch.
- **Selftest**: None.
- **Trigger**: Release pipeline.

### `release.sh`
- **Purpose**: 8-step automated release pipeline (disk space guard, bump PR, pr-gate merge, tag push, artifact download, smoke check, DMG plist verification, and optional install).
- **Usage**: `scripts/release.sh [--dry-run] [--install] <version>`
- **Exit Codes**: `0` on success, `1` on general failure, `2` on smoke test failure, `3` on pending bump PR CI.
- **Selftest**: `scripts/release-selftest.sh`.
- **Trigger**: QA & Release Engineer or automated release routine.

### `release-check.sh`
- **Purpose**: Comprehensive pre-release gate running build, tests, verify, and packaged smoke tests.
- **Usage**: `scripts/release-check.sh`
- **Exit Codes**: `0` on success, `1` on check failure, `2` on smoke failure.
- **Selftest**: None.
- **Trigger**: Pre-release verification.

### `release-selftest.sh`
- **Purpose**: Hermetic selftest suite for `release.sh` stubbing GitHub CLI, git, hdiutil, and verify commands.
- **Usage**: `scripts/release-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `smoke-packaged.sh`
- **Purpose**: Launch verification for unpacked packaged app artifact in isolated state directory.
- **Usage**: `scripts/smoke-packaged.sh <path-to-zip>`
- **Exit Codes**: `0` on clean smoke pass, `2` on smoke failure or missing artifact.
- **Selftest**: None.
- **Trigger**: `scripts/release.sh`, `scripts/release-check.sh`, CI.

### `sync-versions.js`
- **Purpose**: Synchronize package versions across root `package.json` and all `packages/*/package.json`, or verify consistency with `--check`.
- **Usage**: `node scripts/sync-versions.js [--check] [version]`
- **Exit Codes**: `0` on success/consistent, `1` on mismatch.
- **Selftest**: None.
- **Trigger**: `scripts/verify.sh`, `scripts/release.sh`.

### `v1-dry-run.sh`
- **Purpose**: Dry-run packaging and release verification for v1 releases.
- **Usage**: `scripts/v1-dry-run.sh`
- **Exit Codes**: `0` on success, non-zero on error.
- **Selftest**: None.
- **Trigger**: Release dry-runs.

### `verify-linux.sh`
- **Purpose**: Execute full verification suite inside an isolated Docker Linux container.
- **Usage**: `scripts/verify-linux.sh`
- **Exit Codes**: `0` on success, non-zero on failure.
- **Selftest**: None.
- **Trigger**: Cross-platform verification.

### `verify-selftest.sh`
- **Purpose**: Selftest suite for `verify.sh` checking zero-test detection and config mutation guards.
- **Usage**: `scripts/verify-selftest.sh`
- **Exit Codes**: `0` on success, non-zero on failure.
- **Selftest**: Self-testing.
- **Trigger**: Test verification.

### `verify.sh`
- **Purpose**: Primary repository gate validating package versions, test tmpdirs, scripts catalog, builds, package unit tests, and git tripwires.
- **Usage**: `scripts/verify.sh`
- **Exit Codes**: `0` on healthy repository, `1` on guardrail violation or test failure.
- **Selftest**: `scripts/verify-selftest.sh`.
- **Trigger**: CI workflow, pre-commit hook, developer verification.

### `worktree.sh`
- **Purpose**: Manage developer and agent worktrees in `~/dev/_scratch/` safely (`new`, `review`, `done`, `list`, `prune`).
- **Usage**: `scripts/worktree.sh <new|review|done|list|prune> [args...]`
- **Exit Codes**: `0` on success, `1` on error or safety refusal.
- **Selftest**: `scripts/worktree-selftest.sh`.
- **Trigger**: Developer CLI, Gump/Rigel bot tasks, automation routines.

### `worktree-selftest.sh`
- **Purpose**: Hermetic selftest suite verifying worktree creation, branch isolation, review worktree detachment, dirty/unmerged refusal, and pruning dry-run.
- **Usage**: `scripts/worktree-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.
