# OpenSand Scripts Catalog

This directory contains repository automation, gatekeepers, benchmarks, build utilities, and release tools.

All scripts in this directory are cataloged below. Automated verification is enforced by `scripts/check-scripts-catalog.sh` (wired into `scripts/verify.sh`).

---

## Catalog Index

| Script | Purpose | Trigger / Caller | Selftest |
| :--- | :--- | :--- | :--- |
| `Chat.tsx` | Phase 5 screen component scaffolded by `screen-kit.sh` (wired into Shell.tsx by the row's PR) | Phase 5 row work | chat-real-window.test.ts |
| `bench-cold-start.ts` | Benchmark daemon startup latency | Manual performance testing | None |
| `bench-first-token.ts` | Benchmark engine model time-to-first-token | Manual performance testing | None |
| `check-doc-links.sh` | Check that local markdown links under `docs/` resolve to real files | `scripts/verify.sh`, CI | `check-doc-links-selftest.sh` |
| `check-hidden-window-spawns.sh` | Fail if a desktop test or helper script spawns Electron without the shared `hermeticElectronEnv` (which sets `OPENSAND_HIDDEN_WINDOW=1`); packaged-app shell launches must set the hidden/smoke flag | `scripts/verify.sh`, CI | `check-hidden-window-spawns-selftest.sh` |
| `check-hidden-window-spawns-selftest.sh` | Hermetic selftest: raw spawn/fork refused, helper-built spawn allowed, packaged launch needs the flag, missing root refused | Pre-commit / verification | Self |
| `check-doc-links-selftest.sh` | Hermetic selftest for the docs link checker | Pre-commit / verification | Self |
| `check-engine-wrapper-sync.sh` | Validate SHA-256 parity of vendored engine wrapper files against committed PIN and upstream skills | `scripts/verify.sh`, CI | None |
| `check-dead-exports.sh` | Fail on NEW exported functions/classes/consts under `packages/*/src` that no other file imports or references; today's findings are seeded in `scripts/dead-exports-allow.txt`. Uses the repo's TypeScript compiler; excludes tests, index.ts re-exports and package entry points | `scripts/verify.sh`, CI | `check-dead-exports-selftest.sh` |
| `check-dead-exports-selftest.sh` | Hermetic selftest: an unreferenced export fails, a seeded allowlist passes, an import clears a finding, and a new dead export fails | Pre-commit / verification | Self |
| `check-raw-errors.sh` | Fail on NEW places in `packages/desktop` where `err.message` / `String(err)` / a stack reaches the user without a classify/format helper; today's findings are seeded in `scripts/raw-errors-allow.txt` | `scripts/verify.sh`, CI | `check-raw-errors-selftest.sh` |
| `check-raw-errors-selftest.sh` | Hermetic selftest: raw HTTP/event errors fail, classified/logged/helper lines pass, a seeded allowlist passes, and a new raw error fails | Pre-commit / verification | Self |
| `check-real-window-nav.sh` | Fail if a real-window test assigns location.hash directly; navigation must go through the shared bounded re-dispatch helper | `scripts/verify.sh`, CI | None |
| `check-test-teardown.sh` | Fail if a desktop test that owns a bridge or server in-process removes a temp directory with a bare `rmSync` instead of `closeThenRemove()` from `test/teardown.ts`; a shutdown still in flight otherwise recreates the dir mid-rm and the teardown dies ENOTEMPTY | `scripts/verify.sh`, CI | `check-test-teardown-selftest.sh` |
| `check-test-teardown-selftest.sh` | Hermetic selftest: a bare rmSync in a bridge-owning test fails and is named, a file with no bridge is skipped, the teardown import passes, and a missing test directory exits 2 | Pre-commit / verification | Self |
| `check-scripts-catalog.sh` | Validate completeness of `scripts/README.md` and selftests | `scripts/verify.sh`, CI | `check-scripts-catalog-selftest.sh` |
| `check-scripts-catalog-selftest.sh` | Hermetic selftest for scripts catalog checker | Pre-commit / verification | Self |
| `clean-disk.sh` | Safe disk reclamation of merged/clean scratch worktrees and caches; reports the Data volume (`/System/Volumes/Data`) with per-target estimates | Manual / low disk space in release | `clean-disk-selftest.sh` |
| `clean-disk-selftest.sh` | Hermetic selftest for disk cleanup script | Pre-commit / verification | Self |
| `install-health-check.sh` | Post-install health check: launch the installed app in isolation and prove it answers with the expected version | `release.sh` Step 9 after `--install` | `install-health-check-selftest.sh` |
| `install-health-check-selftest.sh` | Hermetic selftest for the post-install health check using a stub app in a temp dir | Pre-commit / verification | Self |
| `mutate.sh` | Thin wrapper kept for the older name; forwards every argument to `mutation-probe.sh` | Automated job proof / mutation testing | `proof-selftest.sh` |
| `lessons-index.sh` | Generate `docs/lessons/INDEX.md` from the one-file-per-lesson entries; `--check` fails when the index is stale, `--stdout` emits without writing, and `--merge <theirs-index>` includes an incoming generated index | `scripts/verify.sh` (`--check`), developer after adding a lesson, `setup-git.sh` merge driver | `lessons-index-selftest.sh` |
| `lessons-index-selftest.sh` | Hermetic selftest for the lessons index generator, stdout mode, merge mode, and its staleness check | Pre-commit / verification | Self |
| `lessons-index-merge-selftest.sh` | Hermetic two-branch rebase proving the custom merge driver retains both lessons and leaves a current index; red when the `.gitattributes` rule is absent | `verify.sh`, CI, pre-commit / verification | Self |
| `setup-git.sh` | Register the idempotent `lessons-index` merge driver in the current repository; called by `worktree.sh new` | `worktree.sh new`, manual clone setup | `lessons-index-merge-selftest.sh` |
| `mesh-judge-probe.sh` | Mutation probe for the Phase 7 mesh judge: flips the Stage 0 exit-code check in the judge source via `mutation-probe.sh`, requires the mesh-judge suite red, then green after restore | Phase 7 S3 verification | `mutation-probe.sh` (via) |
| `mesh-tournament-probe.sh` | Mutation probe for the Phase 7 tournament runner: flips the attempt outcome's check verdict in the engine tournament source via `mutation-probe.sh`, requires the mesh-tournament suite red, then green after restore | Phase 7 S4 verification | `mutation-probe.sh` (via) |
| `mesh-routing-probe.sh` | Mutation probe for the Phase 7 start-rung routing: loosens the §2.3 qualification check in the engine routing source via `mutation-probe.sh`, requires the mesh-routing suite red, then green after restore | Phase 7 S5 verification | `mutation-probe.sh` (via) |
| `mission-suite.sh` | Phase 8 S1/S4 acceptance suite: five fixed scripted missions (verify, false claim, repair, repair-budget, changed lines) over the real `opensand-engine --stdio`, asserting status, receipt, check output, `mission.target` and the harness target block; `--target local`, `--target container` (docker) and `--target ssh` (needs `OPENSAND_SSH_TARGET`, exit 2 when missing) | Phase 8 S4 verification; per-target phase gate | `mission-suite-selftest.sh` |
| `target-probe.sh` | Phase 8 S2 target probe: builds the target bundle, loads a temp `targets.json` through the strict store, then proves the container target on `node:22-bookworm` — hello says linux, exec carries the `OPENSAND_TARGET_ID` marker, a write/read round-trips through the bind mount, an outside path is refused, and the container is removed on exit | Phase 8 S2 verification | None |
| `mission-suite-selftest.sh` | Hermetic selftest for `mission-suite.sh`: argument and exit-code contract, no build before a target is refused, and every fixture is valid JSON whose check names its target first | Pre-commit / verification | Self |
| `mutation-probe.sh` | The one mutation probe: break a tracked file on purpose, prove the test goes red, restore it byte-identically, prove green again | Selftest authors, QA / Release Engineer | `proof-selftest.sh` |
| `lint-brief.sh` | Shape lint for bot briefs: Goal, Done when, Scope, Report back | `scripts/verify.sh`, bot handoff | `lint-brief-selftest.sh` |
| `lint-brief-selftest.sh` | Hermetic selftest for the brief linter | Pre-commit / verification | Self |
| `brief-row.sh` | Draft Phase 5 row briefs directly from inventory, server routes and base SHA | Bot handoff, Phase 5 row planning | `brief-row-selftest.sh` |
| `brief-row-selftest.sh` | Hermetic selftest for the brief row generator | Pre-commit / verification | Self |
| `desktop-test.js` | Desktop test runner: non-real-window files in parallel, then one process per real-window file with per-file duration and a 120 s per-file ceiling that fails by name | `packages/desktop` test script (`pnpm --filter @opensand/desktop test`) | `desktop-test-selftest.js` |
| `desktop-test-selftest.js` | Hermetic selftest for `desktop-test.js` using fake test files: phase order, per-file duration log, and a slow file failing by name | Pre-commit / verification | Self |
| `phase7-e2e.sh` | Phase 7 S5 end-to-end check: routes.json + stats fixture into a temp `OPENSAND_HOME`, a 3-attempt tournament against the local HTTP stub, worktree/attempts-root assertions, receipt rows vs log records one-to-one, a stats fixture that moves the ladder start with the `mesh.route.selected` record to prove it, and the CLI verbs (`mission reconcile`, `mission attempt restore`) | Phase 7 S5 verification | `mutation-probe.sh` (via) |

| `opensand-completion.bash` | Bash tab completion definitions | User shell environment | None |
| `opensand-completion.zsh` | Zsh tab completion definitions | User shell environment | None |
| `opensand-desktop.sh` | Helper script to launch OpenSand desktop in development | Manual local development | None |
| `package-cli.sh` | Package standalone CLI executables and archives | Release workflows / CI | None |
| `proof-red-green.sh` | Prove test fails on base ref and passes on HEAD | Automated job proof / CI / pre-PR | `proof-selftest.sh` |
| `proof-report.sh` | Generate markdown proof report with PR metadata, diff hunks, CI IDs, red-green, and mutation logs | Automated job proof / PR review | `proof-selftest.sh` |
| `proof-selftest.sh` | Hermetic selftest suite for proof-red-green, mutate, and proof-report scripts | Pre-commit / verification | Self |
| `pr-gate.sh` | 5-step pre-merge verification and checkpoint gate; re-running it on an already-merged PR only re-checks main CI (never rebase/tag/push); `--when-green` rebases a PR that fell behind main (max 3 attempts), self-healing an INDEX.md-only conflict, before waiting for CI; after merge it waits for main CI and exits 4 on red; queued CI runs extend the no-checks grace window (per-run Jobs API as source of truth); a watch exit with no failed check is retried as pending to the deadline | Pre-merge review workflow | `pr-gate-selftest.sh` |
| `pr-gate-selftest.sh` | Hermetic selftest for PR gate script, including the already-merged idempotency cases (no rebase/tag/push, exit 0 green, 4 red), the INDEX.md-only conflict auto-resolve, fail-closed stale index, post-merge main CI green/red/no-run/opt-out cases and the queued-CI-run cases (queued → green/red/timeout naming queued jobs, run-list lag → Jobs API decides), and pending-watch exits followed by success, a named failure, or a bounded pending timeout | Pre-commit / verification | Self |
| `pre-commit.sh` | Git pre-commit hook enforcing staged-secret scan, blanket-add guard and test suite | Git pre-commit hook | `pre-commit-selftest.sh` |
| `pre-commit-selftest.sh` | Hermetic selftest for the staged secret scan in `pre-commit.sh` (clean commit allowed, each blocked pattern refused, hook run from outside the repo) | Pre-commit / verification | Self |
| `pre-push.sh` | Git pre-push hook that scans only the commits introduced by each pushed ref with pinned gitleaks 8.30.1; findings name file and line with values redacted | Git pre-push hook / manual | `pre-push-selftest.sh` |
| `pre-push-selftest.sh` | Hermetic real-gitleaks selftest: clean and planted commits, new and existing refs, deletion, version refusal, no value disclosure, and main versus PR/all-refs scan scope | Pre-push / verification | Self |
| `provenance-gate.sh` | Build artifact provenance and digest verification gate | Release workflows / CI | None |
| `release.sh` | 9-step end-to-end automated release pipeline; Step 1 guards free space on the writable data volume; Step 9 runs the post-install health check | Release Engineer / CI | `release-selftest.sh` |
| `release-check.sh` | Full release verification and smoke test gate | Pre-release sanity gate | None |
| `release-selftest.sh` | Hermetic selftest for automated release pipeline | Pre-commit / verification | Self |
| `smoke-packaged.sh` | Packaged application launch verification in isolated state | CI / release smoke gate | None |
| `engine-smoke.sh` | Packaged application outside engine smoke test: verifies all 7 engines in Settings (#settingEngine) in isolated state | CI / pre-release verification | `engine-smoke-selftest.sh` |
| `engine-smoke-selftest.sh` | Hermetic selftest for engine-smoke.sh verifying help, missing paths, and error handling | Pre-commit / verification | Self |
| `smoke-linux.sh` | Linux `.deb` smoke: extract, reject Mach-O, launch packaged app under xvfb with isolated state, require `/api/diagnostics` version | `release.sh` Step 7 on Linux / release CI | `smoke-linux-selftest.sh` |
| `smoke-linux-selftest.sh` | Hermetic selftest for `smoke-linux.sh` with fake dpkg-deb/xvfb/app/diagnostics fixtures | Pre-commit / verification | Self |
| `status-report.sh` | Read-only owner summary: recent merges, open PRs + CI/behind, main CI, latest release, disk; `--json` for the same data | Manual / owner status report | `status-report-selftest.sh` |
| `status-report-selftest.sh` | Hermetic selftest for status-report.sh with a stubbed `gh` (no network) | Pre-commit / verification | Self |
| `screen-kit.sh` | Phase 5 screen starter kit: scaffolds a new shell screen's component, its real-window test (960x740 + full screen, screenshots into the gitignored .opensand-snapshots folder) and its scripts/README.md rows | Phase 5 row work | `screen-kit` `--selftest` flag |
| `sync-versions.js` | Synchronize and check version strings across workspace packages | `verify.sh`, release.sh | None (checked by verify) |
| `v1-dry-run.sh` | Validate v1 packaging and DMG generation pipeline | Manual release validation | None |
| `verify-linux.sh` | Run verification suite inside isolated Linux container | Local pre-CI cross-platform test | None |
| `verify-selftest.sh` | Hermetic selftest for verify.sh guardrails | Verification test suite | Self |
| `verify.sh` | Core repository verification gate (versions, build, tests, tripwires) | CI, pre-commit, manual | `verify-selftest.sh` |
| `worktree.sh` | OpenSand automated worktree lifecycle manager (base, new, save, review, done, list, prune); `new` registers the lessons-index merge driver, runs `worktree-prune.sh --apply` before its free-space guard on the writable data volume, and no command acts on the main checkout | Developer, bots, release automation | `worktree-selftest.sh` |
| `worktree-selftest.sh` | Hermetic selftest suite for worktree lifecycle manager, including the main-checkout guard (cwd, symlink, source repo, target) and the regenerated-screenshot skip | Pre-commit / verification | Self |
| `worktree-prune.sh` | Remove only merged-PR (or branch-deleted-after-merge), clean, 2h-unchanged scratch worktrees and stale temp folders; dry-run by default, `--apply` to delete; reports free space before/after | `worktree.sh new` (automatic), manual / low disk space | `worktree-prune-selftest.sh` |
| `worktree-prune-selftest.sh` | Hermetic selftest for disk pruning: merged+clean removed, dirty/recent/unmerged/base kept, deleted-branch case, temp folders and gh-failure fail-closed | Pre-commit / verification | Self |
| `owner-guard-selftest.sh` | Hermetic selftest suite for owner checkout guard in `worktree.sh` and `pr-gate.sh` | Pre-commit / verification | Self |

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

### `check-doc-links.sh`
- **Purpose**: Check that local markdown links under `docs/` resolve to real files, naming file and line for each broken link. External URLs, `mailto:`, pure `#anchors` and fenced code are ignored; image links are checked like any other link. The doc lint for process-map node 4.
- **Usage**: `scripts/check-doc-links.sh` (`CHECK_DOC_LINKS_DIR` overrides the docs directory for the selftest).
- **Exit Codes**: `0` all local links resolve, `1` a broken link, `2` bad usage or missing `python3`.
- **Selftest**: `scripts/check-doc-links-selftest.sh`.
- **Trigger**: `scripts/verify.sh`, CI.

### `check-doc-links-selftest.sh`
- **Purpose**: Hermetic selftest with a temp docs tree: valid relative/anchored/external/image/subdir links, fenced-code links ignored, broken link named with file and line, missing docs dir refused. Point `CHECK_DOC_LINKS_SCRIPT` at a mutant copy to prove a case sees the breakage.
- **Usage**: `scripts/check-doc-links-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `check-engine-wrapper-sync.sh`
- **Purpose**: Validate SHA-256 cryptographic parity of vendored coding-agent engine wrapper files (`agent_wrap.mjs`, `engine_facts.mjs`) against the committed `PIN` file in `packages/coordinator/src/engines/vendor/`. In local environments with `~/SKILLS`, checks for upstream drift (warns by default, fails on `--strict`). The `--sync` flag copies upstream sources and regenerates `PIN`.
- **Usage**: `scripts/check-engine-wrapper-sync.sh [--sync|--strict]`
- **Exit Codes**: `0` on match / clean sync, `1` on hash mismatch or drift under `--strict`.
- **Selftest**: None (`external-engine-runner.test.ts` tests hash mismatch and failure).
- **Trigger**: `scripts/verify.sh`, CI, PR gate.
### `check-dead-exports.sh`
- **Purpose**: List exported functions, classes and consts under `packages/*/src` that no other file imports or references, then fail only on findings not already in `scripts/dead-exports-allow.txt`. This catches a helper written but never wired up (e.g. an error classifier only a test calls). Tests (`*.test.ts`, `*.spec.ts`), index.ts re-exports and package entry points are excluded as findings; imports from any file count as references. Parses source with the repo's own `typescript` compiler (no new dependency); `pnpm install` must have run first.
- **Usage**: `scripts/check-dead-exports.sh` (`DEAD_EXPORTS_PACKAGES_DIR`, `DEAD_EXPORTS_ALLOW`, `DEAD_EXPORTS_ROOT` override the scan, allowlist and path root for the selftest). Every finding prints as `FINDING <allowlist-key>` and as `path:line: <kind> <name>`; the key is `relative-path|kind name`, so line shifts do not invalidate the allowlist.
- **Exit Codes**: `0` no new dead exports, `1` a new dead export, `2` bad setup (missing packages dir/allowlist or TypeScript not installed).
- **Selftest**: `scripts/check-dead-exports-selftest.sh`.
- **Trigger**: `scripts/verify.sh` (after install, before docs-only exit), CI.

### `check-dead-exports-selftest.sh`
- **Purpose**: Hermetic temp-dir fixture proving the check finds an unreferenced export while ignoring an imported one, passes once findings are seeded into its allowlist, stops reporting an export once another file imports it, and fails on a newly planted dead export. Point `DEAD_EXPORTS_CHECK_SCRIPT` at a mutant to prove a case sees the breakage.
- **Usage**: `scripts/check-dead-exports-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, verification.

### `check-raw-errors.sh`
- **Purpose**: Flag lines in `packages/desktop` (renderer, `src/` and IPC/server paths) that send a raw `err.message`, `String(err)` or stack into a user-facing sink — an HTTP `res.end`/`JSON.stringify` error field, an emitted error event, a toast/dialog or a failed-state message. Logging, control-flow reads (`err.message.includes(...)`) and values already routed through `classifyError`/`formatError`/a local formatter are not findings. Fails only on findings absent from `scripts/raw-errors-allow.txt`, using a `path|source-line` key that survives line shifts.
- **Usage**: `scripts/check-raw-errors.sh` (`RAW_ERRORS_SCAN_DIR`, `RAW_ERRORS_ALLOW`, `RAW_ERRORS_ROOT` override the scan, allowlist and path root for the selftest). Findings print as `FINDING <key>` and `path:line: <source line>`.
- **Exit Codes**: `0` no new raw error paths, `1` a new raw error path, `2` bad setup.
- **Selftest**: `scripts/check-raw-errors-selftest.sh`.
- **Trigger**: `scripts/verify.sh` (after install, before docs-only exit), CI.

### `check-raw-errors-selftest.sh`
- **Purpose**: Hermetic temp-dir fixture proving raw HTTP response and event errors are found while classified, logged and formatter-helper lines are not; seeding the allowlist passes; a newly planted raw toast error fails and is named. Point `RAW_ERRORS_CHECK_SCRIPT` at a mutant to prove a case sees the breakage.
- **Usage**: `scripts/check-raw-errors-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, verification.

### `check-hidden-window-spawns.sh`
- **Purpose**: Fail with file and line when a file under `packages/desktop/test` or `scripts` spawns Electron without building its env through `hermeticElectronEnv` (which sets `OPENSAND_HIDDEN_WINDOW=1`, so main.ts creates a hidden window, no Dock icon and no focus steal). Packaged-app shell launches must set `OPENSAND_HIDDEN_WINDOW=1` or `OPENSAND_SMOKE=1`. `HIDDEN_SPAWN_SCAN_DIRS` overrides the scan roots.
- **Usage**: `scripts/check-hidden-window-spawns.sh`
- **Exit Codes**: `0` no bypasses, `1` a bypass was found, `2` a scan root is missing.
- **Selftest**: `scripts/check-hidden-window-spawns-selftest.sh`.
- **Trigger**: `scripts/verify.sh`, CI.

### `check-hidden-window-spawns-selftest.sh`
- **Purpose**: Hermetic selftest with temp files: raw Electron spawn and fork are refused, helper-built spawn is allowed, packaged-app launch needs the hidden flag, missing scan root is refused, and the real tree passes.
- **Usage**: `scripts/check-hidden-window-spawns-selftest.sh`
- **Exit Codes**: `0` all cases pass, `1` a case failed.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit / verification.

### `check-real-window-nav.sh`
- **Purpose**: Fail with file and line when any `*-real-window.test.ts` assigns location.hash directly. The one-shot change is lost when the view's hashchange subscriber mounts a tick after the DOM appears; runners must call the shared navigateToView helper, which re-dispatches with a bounded retry until the target view is visible. `REAL_WINDOW_TEST_DIR` overrides the scanned directory.
- **Usage**: `scripts/check-real-window-nav.sh`
- **Exit Codes**: `0` no direct assignments, `1` a direct assignment was found, `2` test directory missing.
- **Selftest**: None (mutation proof recorded in docs/lessons).
- **Trigger**: `scripts/verify.sh`, CI.

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
- **Exit Codes**: `0` on success, `1` on invalid arguments, `124` when a long command (du, rm, pnpm, npm) exceeds the hard 300s timeout.
- **Reporting**: Free space is measured with `df -k` on the writable data volume — `/System/Volumes/Data` on macOS, `$HOME` on Linux CI — never the read-only system snapshot (`/dev/disk3s1s1`). Prints the volume, before/after numbers, and a per-target `du -sk` estimate of what would be freed.
- **Timeouts**: du, rm, pnpm and npm run under a hard 300s timeout (Python `signal.alarm` kills the child).
- **Selftest**: `scripts/clean-disk-selftest.sh`.
- **Trigger**: Manual invocation or automated via `scripts/release.sh` when free disk space is under 8 GB.

### `clean-disk-selftest.sh`
- **Purpose**: Hermetic selftest suite for `clean-disk.sh` using isolated git repos to ensure dirty and unmerged worktrees are never cleaned, and that free space is reported for the data volume (df stub case).
- **Usage**: `scripts/clean-disk-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `install-health-check.sh`
- **Purpose**: Prove an installed OpenSand app starts and answers after a release install. Launches the installed bundle's own binary with a fresh isolated `OPENSAND_STATE_DIR` and `OPENSAND_SMOKE=1`, waits for its local server port and token, queries `GET /api/diagnostics`, checks the reported version, then terminates exactly the launched PID and removes the temp state. Never uses `~/.opensand` as state and fails if that directory changes during the check.
- **Usage**: `scripts/install-health-check.sh <path/to/OpenSand.app> <expected-version>` (`OPENSAND_HEALTH_TIMEOUT_SECONDS` bounds the startup wait, default 30).
- **Exit Codes**: `0` when the app starts and answers with the expected version, `1` on missing bundle, no answer, non-200 response, version mismatch, or state-isolation breach.
- **Selftest**: `scripts/install-health-check-selftest.sh`.
- **Trigger**: `scripts/release.sh` Step 9 when `--install` is passed.

### `install-health-check-selftest.sh`
- **Purpose**: Hermetic selftest suite for `install-health-check.sh` using a stub installed app in a throwaway dir (no real `OpenSand.app` and no `~/.opensand`): happy path, wrong version, no answer, early exit, and missing bundle.
- **Usage**: `scripts/install-health-check-selftest.sh` (`OPENSAND_HEALTH_CHECK_SCRIPT` points at a mutant for a mutation proof).
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `lint-brief.sh`
- **Purpose**: Shape lint for bot briefs: each brief must name Goal, Done when, Scope and Report back. Accepts `Goal:` / `**Goal:**` / `## Goal` forms and multiple files; `-` reads stdin. Checks presence, not the quality of the prose. The brief lint for process-map node 5.
- **Usage**: `scripts/lint-brief.sh <brief.md> [...]  ('-' reads stdin)`
- **Exit Codes**: `0` all briefs well-shaped, `1` a section missing, `2` bad usage or unreadable file.
- **Selftest**: `scripts/lint-brief-selftest.sh`.
- **Trigger**: `scripts/verify.sh` (checks `docs/brief-template.md`), bot handoff before work starts.

### `lint-brief-selftest.sh`
- **Purpose**: Hermetic selftest of the brief linter: colon and markdown-heading styles pass, each of the four missing sections is caught, empty file names all four, bad batch/usage/stdin cases behave. Point `LINT_BRIEF_SCRIPT` at a mutant copy to prove a case sees the breakage.
- **Usage**: `scripts/lint-brief-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `brief-row.sh`
- **Purpose**: Draft Phase 5 row briefs directly from the repository: extracts row metadata from `docs/design/phase5-view-inventory.md`, discovers matching server routes and body validation in `packages/desktop/src/desktop-server.ts` with HTTP methods taken directly from code (`req.method === '...'`), reads base SHA from origin/main, emits a standardized brief skeleton, and lints the output via `lint-brief.sh` when `--out` is specified.
- **Usage**: `scripts/brief-row.sh <row> [--out <file>]`
- **Exit Codes**: `0` on success, `2` on bad or missing row / usage error, `3` if the row is already marked done in the inventory.
- **Selftest**: `scripts/brief-row-selftest.sh`.
- **Trigger**: Bot handoff, Phase 5 row drafting.

### `brief-row-selftest.sh`
- **Purpose**: Hermetic selftest suite for `brief-row.sh` verifying pending row drafting, done row refusal (exit 3), bad/missing row usage checks (exit 2), HTTP method extraction from code rather than comments (e.g. PATCH vs POST), and request-body validation extraction.
- **Usage**: `scripts/brief-row-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.


### `mutate.sh`
- **Purpose**: Thin wrapper kept for the older name. The implementation is `mutation-probe.sh`, which supports both mutation forms (a perl substitution, or one line replaced); this script forwards every argument unchanged, so callers that still use `mutate.sh` keep working.
- **Usage**: `scripts/mutate.sh <file> <line> <replacement> -- <test command>` (forwarded to `mutation-probe.sh`).
- **Exit Codes**: whatever `mutation-probe.sh` returns.
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
- **Purpose**: Hermetic selftest suite verifying all pass and failure modes of `proof-red-green.sh`, `mutation-probe.sh` (both mutation forms, the untracked-target refusal and the `mutate.sh` wrapper) and `proof-report.sh` using a throwaway git repository.
- **Usage**: `scripts/proof-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification (`verify-selftest.sh`).

### `pr-gate.sh`
- **Owner Checkout Guard**: refuses (exit 4 with "pr-gate.sh: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base") when `--git-common-dir` matches `$HOME/dev/opensand/.git` (or `OPENSAND_PROTECTED_CHECKOUT`). Overridden only with `OPENSAND_OWNER=1`.
- **Purpose**: 5-step automated pre-merge verification gate: CI rollup check, base freshness, diff hygiene, checkpoint tag creation/remote verification, and merge. With `--when-green`, a PR behind origin/main is rebased and pushed first so bots no longer babysit merges.
- **Usage**: `scripts/pr-gate.sh [--allow-lockfile] [--allow-binary] [--allow-github] [--dry-run] [--when-green [--timeout <min>]] [--no-post-merge-check] [--no-review "<reason>"] <PR-number>`
- **`--allow-github`**: permits modifications to files under `.github/` in the PR diff, requiring the `owner-approved-github` label on the PR. With no flag, changes under `.github/` are forbidden (exit 1). When `--allow-github` is passed without the `owner-approved-github` label, the gate fails immediately explaining that owner approval is required. When both the flag and the label are present, each allowed `.github/` file is printed with a WARNING line.
- **`--when-green`**: first watches pending CI with `gh pr checks --watch`, bounded by `--timeout` minutes (default 40), then runs the normal 5 checks and merges. If CI has not registered any check yet (right after the PR is opened) it waits for the first one inside the same deadline. Red CI exits `1` and names the failing job. If `gh pr checks --watch` exits nonzero but the rollup reports no failed check, the gate treats that as pending and retries within the same deadline; a timeout exits `3`. While no check is registered, a queued, pending, waiting, requested or in-progress workflow run for the head commit — read from the per-run Jobs API (`gh api repos/{owner}/{repo}/actions/runs/<id>/jobs`), because `gh run list` status can lag — extends the no-checks grace window, bounded by `PR_GATE_QUEUED_RUN_MAX_SECONDS` (default 600s); a timeout while still queued names the queued jobs.
- **Auto-rebase**: if the PR is behind origin/main, or GitHub reports `mergeStateStatus` `BEHIND`/`DIRTY` or `mergeable` `CONFLICTING` (baseRefOid tracks the live base tip, so it alone cannot detect staleness), the gate rebases the head branch onto origin/main in a temporary worktree, pushes it back with `--force-with-lease` to that PR branch only, waits for its new CI, and re-checks. Main can move again, so the cycle repeats at most 3 times (`PR_GATE_REBASE_ATTEMPTS`, default `3`) and then exits `1`. A conflicting rebase runs `git rebase --abort`, prints the conflicting files and exits `1` without pushing. Fork PRs and force-pushing main are refused.
- **INDEX-only conflict**: when the *only* conflicting file is `docs/lessons/INDEX.md`, the gate regenerates it with `scripts/lessons-index.sh` (the generator `worktree.sh save` uses), re-checks that the index is current, stages it and runs `git rebase --continue`, then pushes as above. Any other conflicting file, a generator error, or a still-stale index aborts with the file list and exits `1` without pushing. `PR_GATE_LESSONS_INDEX_SCRIPT` overrides the generator path for the selftest.
- **Drafts**: a PR that is still a draft (as opened by `worktree.sh save`) is refused in check 1, before the checkpoint tag is pushed, with the hint `gh pr ready <N>`.
- **Post-merge main CI check**: on by default after a successful merge. It finds the CI run for the merge commit on main via `gh run list --commit <merge-sha>` (a run that has not registered yet is pending, not red) and waits for it with the same bounded `--timeout` deadline as `--when-green`. Green prints `main CI green for <sha>` and exits `0`. Red prints the failing job names and `gh run view <id> --log-failed` and exits `4`, so a red main is never silent. Pending/no-run timeout exits `3`. `--no-post-merge-check` skips the wait. The merge itself is never rolled back.
- **Already-merged PR (idempotent re-run)**: the first thing the gate does is read `gh pr view <PR> --json state,mergeCommit`. If the PR is `MERGED`, it prints `PR #<n> already merged as <sha>` and runs *only* the post-merge main CI check for that merge commit: green exits `0`, red exits `4`, a pending/no-run timeout exits `3`. It never rebases, tags, fetches or pushes, so re-running it on a finished PR is safe. With `--no-post-merge-check` or `--dry-run` it prints the line and exits `0` at once.
- **Exit Codes**: `0` on success, `1` on validation failure, red PR CI, rebase conflict/exhaustion, or a refused fork; `3` on pending PR CI / `--when-green` timeout / post-merge run never appearing; `4` on red main CI after the merge.
- **Selftest**: `scripts/pr-gate-selftest.sh`.
- **Trigger**: Pre-merge workflow.

### `pr-gate-selftest.sh`
- **Purpose**: Hermetic selftest suite for `pr-gate.sh` stubbing `gh`, `git` and the lessons index generator. Covers re-running the gate on an already-merged PR: the merge sha is reported, only the post-merge check runs, every stubbed git call is logged and asserted free of `push`/`fetch`/`tag`/`worktree`/`rebase`, and it exits `0` on green main CI or `4` on red. Covers the auto-rebase paths too: behind → clean rebase → force-push → wait → merge, rebase conflict → abort with the file list and no push, and the 3-attempt cap when main keeps moving. It also covers an INDEX.md-only conflict (regenerate, stage, continue, merge), INDEX.md plus another file (abort naming both), and a regenerated index that is still stale (fail closed, no push), plus the post-merge main CI cases: green (exit 0), red (exit 4, job names and `--log-failed` hint), a run that never appears (bounded exit 3), and `--no-post-merge-check` skipping the wait, and the queued-CI-run cases: queued → waits then green, queued → check turns red, still queued at the `PR_GATE_QUEUED_RUN_MAX_SECONDS` bound → exit 3 naming the queued jobs, `gh run list` status lagging behind the Jobs API, and `gh pr checks --watch` exiting nonzero while a check is still pending (then success, then a named failure, or still pending at the deadline). Covers diff hygiene for `.github/` modifications too (forbidden by default without flag, refused when `--allow-github` lacks the `owner-approved-github` label, and allowed with warnings for each file when both flag and label are present). Point `PR_GATE_SCRIPT` at a mutant to prove a case fails when its step is removed.
- **Usage**: `scripts/pr-gate-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `pre-commit.sh`
- **Purpose**: Git pre-commit guard that scans staged added lines for secrets (via `scripts/lib/worktree-safety.sh`, naming file and line but never the value), blocks blanket additions, unsets git environment variables, executes builds/tests, and verifies git config tripwires.
- **Usage**: Executed by `.githooks/pre-commit` or manually via `scripts/pre-commit.sh`.
- **Exit Codes**: `0` on success, `1` on violation or failure.
- **Selftest**: `scripts/pre-commit-selftest.sh`.
- **Trigger**: Git pre-commit hook.

### `pre-commit-selftest.sh`
- **Purpose**: Hermetic selftest of the staged secret scan: a clean staged change is allowed, and each blocked pattern (`sk-`, `sk-or-`, `ghp_`, `AKIA` + 16, PEM private key block) refuses the commit with the file and line named and the value withheld. Fake keys are built at runtime by concatenation, so no literal key is committed.
- **Usage**: `scripts/pre-commit-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `pre-push.sh`
- **Purpose**: Git pre-push guard that scans only the commits introduced by each pushed ref with gitleaks 8.30.1. Existing refs use `remote..local`; new refs scan their reachable history; deletions are skipped. Findings name the file and line with candidate values redacted.
- **Usage**: `scripts/pre-push.sh <remote-name> <remote-url>` reads Git's pre-push ref updates from stdin. Install once per clone with `cp scripts/pre-push.sh "$(git rev-parse --git-path hooks)/pre-push"`.
- **Env**: `GITLEAKS_BIN` overrides the gitleaks executable; the version must be exactly `8.30.1`.
- **Exit Codes**: `0` when clean or nothing needs scanning, `1` when a secret is found, `2` for missing/wrong gitleaks, malformed input, unavailable commits, or scanner failure.
- **Selftest**: `scripts/pre-push-selftest.sh`.
- **Trigger**: Git pre-push hook or manual invocation with ref updates on stdin.

### `pre-push-selftest.sh`
- **Purpose**: Hermetic selftest using real gitleaks 8.30.1. A clean pushed commit passes; planted keys on existing and new refs fail with the file named and value withheld; deletion and wrong-version paths are covered. It asserts the workflow's pinned event-scoped command and proves an unmerged planted commit passes a main-only scan, fails a PR `base..head` scan, and fails the old all-refs scan.
- **Usage**: `GITLEAKS_BIN=/path/to/gitleaks scripts/pre-push-selftest.sh` (or put pinned gitleaks on `PATH`).
- **Exit Codes**: `0` on success, `1` on test failure, `2` when pinned gitleaks is unavailable.
- **Selftest**: Self-testing.
- **Trigger**: Pre-push / verification.

### `provenance-gate.sh`
- **Purpose**: Verify artifact commit provenance against git metadata.
- **Usage**: `scripts/provenance-gate.sh <artifact>`
- **Exit Codes**: `0` on verified, `1` on mismatch.
- **Selftest**: None.
- **Trigger**: Release pipeline.

### `release.sh`
- **Purpose**: 9-step automated release pipeline (disk space guard on the writable data volume, bump PR, pr-gate merge, tag push, artifact download of `*.dmg`/`*.zip`/`*.AppImage`/`*.deb`, release notes from merged PR titles, smoke check, DMG plist verification, and optional install followed by a post-install health check). On Linux it downloads and smokes the `.deb` with `smoke-linux.sh` and skips the macOS-only `hdiutil`/install steps; macOS behavior is unchanged.
- **Usage**: `scripts/release.sh [--dry-run] [--install] <version>`
- **Env**: `RELEASE_DOWNLOAD_TIMEOUT_SECONDS` (default `600`) and `RELEASE_DOWNLOAD_POLL_SECONDS` (default `15`) bound the Step 5 retry that waits for `release.yml` to publish the assets. `OPENSAND_HEALTH_CHECK_SCRIPT` overrides the Step 9 health check path for the selftest.
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
- **Purpose**: Hermetic selftest suite for `release.sh` stubbing GitHub CLI, git, hdiutil, verify commands, and (for the disk guard) `df`. Covers both OS branches via `OPENSAND_RELEASE_OS` and asserts all four download patterns (`*.dmg`, `*.zip`, `*.AppImage`, `*.deb`).
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

### `smoke-linux.sh`
- **Purpose**: Prove a Linux `.deb` really runs. Extracts it with `dpkg-deb -x` into a fresh temp dir, rejects any Mach-O magic in the extracted tree, derives the executable from the packaged `.desktop` `Exec=` entry (no `eval`), and launches that packaged binary with `xvfb-run -a`, `OPENSAND_SMOKE=1` and isolated `HOME`/`OPENSAND_HOME`/state. It reads `server.port`/`server.token` without printing the token, calls `/api/diagnostics` with the token and requires the reported version to equal the bundle version from `dpkg-deb -f <deb> Version`. Prints exactly `OpenSand <version> linux ok`. A Mach-O file, an early app exit, a missing port file, a wrong version or a non-200 response is a hard failure; there is no repo/runtime fallback. Only the launched PID/process group is terminated.
- **Usage**: `scripts/smoke-linux.sh <path/to/OpenSand*.deb>` (`OPENSAND_SMOKE_STARTUP_TIMEOUT_SECONDS` bounds startup, default 60). Override points for hermetic testing: `OPENSAND_DPKG_DEB`, `OPENSAND_XVFB_RUN`, `OPENSAND_CURL`.
- **Exit Codes**: `0` on success, `1` on any failure.
- **Selftest**: `scripts/smoke-linux-selftest.sh`.
- **Trigger**: `scripts/release.sh` Step 7 on Linux, `build-linux` release CI job.

### `smoke-linux-selftest.sh`
- **Purpose**: Hermetic selftest for `smoke-linux.sh` with fake `dpkg-deb`/`xvfb-run`/`curl` and a fixture packaged app (no real `.deb`, display, root or downloaded content): success with exact output and no secret leak, wrong diagnostics version, early app exit, port timeout with a tiny budget, Mach-O rejection, missing argument, and no secret on a failure path. Set `OPENSAND_SMOKE_LINUX_SCRIPT` to a mutant to prove a case sees the breakage.
- **Usage**: `scripts/smoke-linux-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `status-report.sh`
- **Purpose**: Print a short, read-only markdown summary for the owner: PRs merged in the last N hours (number, title, merge sha), open PRs with CI state and whether each is behind main, the latest main CI run result, the latest release tag, and free space on the data volume. `--json` emits the same data as JSON. Never pushes, merges, comments or edits, and never prints a token.
- **Usage**: `scripts/status-report.sh [--hours N] [--json]`
- **Exit Codes**: `0` on success, `1` on bad arguments or a failed/unauthenticated `gh` call (clear error).
- **Selftest**: `scripts/status-report-selftest.sh`.
- **Trigger**: Manual owner status report / debugging.

### `status-report-selftest.sh`
- **Purpose**: Hermetic selftest for `status-report.sh` using a stub `gh` with recorded JSON (no network): normal day with N-hours filtering, no merges, red main CI, `gh` not signed in, and `--json` that parses with `python3 -m json.tool`.
- **Usage**: `scripts/status-report-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

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
- **Purpose**: Primary repository gate validating package versions, test tmpdirs, scripts catalog, generated lessons index and its two-branch rebase merge, builds, package unit tests, and git tripwires.
- **Usage**: `scripts/verify.sh`
- **Exit Codes**: `0` on healthy repository, `1` on guardrail violation or test failure.
- **Selftest**: `scripts/verify-selftest.sh`.
- **Trigger**: CI workflow, pre-commit hook, developer verification.

### `lessons-index.sh`
- **Purpose**: Lessons are one file each in `docs/lessons/YYYY-MM-DD-slug.md` (`# Title`, then **Trap**, **Root Cause**, **Rule**), so two PRs never conflict on a shared file. This script validates every entry and generates `docs/lessons/INDEX.md` (sorted by filename). `scripts/verify.sh` runs it with `--check`, which fails while the index is stale. `AGENTS_LEARNING.md` history is not rewritten.
- **Usage**: `scripts/lessons-index.sh [--check|--stdout|--merge <theirs-index>]` (`OPENSAND_LESSONS_DIR` overrides the directory, for the selftest). `--stdout` emits the generated bytes without writing the file. `--merge` unions the current lesson files with entries from an incoming generated index, because Git can invoke a merge driver before checking out the incoming lesson file.
- **Exit Codes**: `0` index written, emitted, merged, or up to date; `1` a malformed entry, a missing/stale/invalid index, or bad usage.
- **Selftest**: `scripts/lessons-index-selftest.sh`.
- **Trigger**: Developer after adding a lesson (regenerate); `verify.sh`, CI; `setup-git.sh` merge driver.

### `lessons-index-selftest.sh`
- **Purpose**: Hermetic selftest for `lessons-index.sh`: generation, sort order, stale detection (new lesson, hand edit, trailing newline), stdout without writes, incoming-index merge mode and its failure paths, malformed entries, and that the repository's own index is current.
- **Usage**: `scripts/lessons-index-selftest.sh` (`LESSONS_INDEX_SCRIPT=<path>` tests a mutated copy)
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `lessons-index-merge-selftest.sh`
- **Purpose**: Hermetic two-branch rebase with one new lesson on each branch. It registers the driver twice to prove idempotency, rebases, and asserts both lessons and their index entries survive with a clean worktree and a current `scripts/lessons-index.sh --check`. Removing the `.gitattributes` rule makes it fail on the expected `docs/lessons/INDEX.md` conflict.
- **Usage**: `scripts/lessons-index-merge-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: `verify.sh`, CI, pre-commit hook, test verification.

### `setup-git.sh`
- **Purpose**: Register `merge.lessons-index.driver` in the current repository. The driver runs `scripts/lessons-index.sh --merge %B > %A`, so Git's three-way merge produces a deterministic index without touching the worktree before incoming files are checked out. Re-running it is idempotent.
- **Usage**: `scripts/setup-git.sh` from any directory inside the repository; `worktree.sh new` invokes it automatically for each new job worktree.
- **Exit Codes**: `0` on success, `1` when the repository or generator is unavailable.
- **Selftest**: `scripts/lessons-index-merge-selftest.sh`.
- **Trigger**: `worktree.sh new`, manual clone setup.

### `mesh-judge-probe.sh`
- **Purpose**: Mutation probe for the Phase 7 mesh judge (design §10 S3). Delegates to `mutation-probe.sh`: flips the Stage 0 exit-code check (`return checkExit === 0;` → `!==`) in the engine's mesh judge source at packages/engine/src/mesh/judge.ts, requires the mesh-judge suite to go RED, restores the file byte-for-byte, and requires GREEN again. A hard 5-minute cap comes from `perl -e alarm`, whose timer survives the exec into the probe and its child test runs (macOS has no `timeout` binary).
- **Usage**: `scripts/mesh-judge-probe.sh` (no arguments).
- **Exit Codes**: whatever `mutation-probe.sh` returns (`0` on GREEN → RED → GREEN).
- **Selftest**: via `scripts/proof-selftest.sh` (the underlying probe).
- **Trigger**: Phase 7 verification, automated job proof.

### `mesh-tournament-probe.sh`
- **Purpose**: Mutation probe for the Phase 7 tournament runner (design §10 S4). Delegates to `mutation-probe.sh`: flips the attempt outcome's check verdict (removes the negation of the check verdict) in packages/engine/src/mesh/tournament.ts, requires the mesh-tournament suite to go RED, restores the file byte-for-byte, and requires GREEN again. A hard 5-minute cap comes from `perl -e alarm`, whose timer survives the exec into the probe and its child test runs (macOS has no `timeout` binary).
- **Usage**: `scripts/mesh-tournament-probe.sh` (no arguments).
- **Exit Codes**: whatever `mutation-probe.sh` returns (`0` on GREEN → RED → GREEN).
- **Selftest**: via `scripts/proof-selftest.sh` (the underlying probe).
- **Trigger**: Phase 7 verification, automated job proof.

### `mesh-routing-probe.sh`
- **Purpose**: Mutation probe for the Phase 7 start-rung routing (design §10 S5). Delegates to `mutation-probe.sh`: loosens the §2.3 qualification check (`>= minPassRate` becomes `> -1`, so an unqualified rung starts anyway) in packages/engine/src/mesh/routing.ts, requires the mesh-routing suite to go RED, restores the file byte-for-byte, and requires GREEN again. A hard 5-minute cap comes from `perl -e alarm`.
- **Usage**: `scripts/mesh-routing-probe.sh` (no arguments).
- **Exit Codes**: whatever `mutation-probe.sh` returns (`0` on GREEN → RED → GREEN).
- **Selftest**: via `scripts/proof-selftest.sh` (the underlying probe).
- **Trigger**: Phase 7 S5 verification, automated job proof.

### `phase7-e2e.sh`
- **Purpose**: The Phase 7 S5 end-to-end check (design §10 S5), written as one command. It builds the engine and CLI packages, writes a `mesh/routes.json` (ladder `stub:a` → `openrouter:deepseek/deepseek-v4.1-flash`) and mission state into a temp `OPENSAND_HOME`, and runs a node driver over the engine's compiled surface: a 3-attempt tournament against the local HTTP stub with a real check command; assertions that `git worktree list` has two entries and the attempts root is empty; that the receipt's Tournament rows match the `mesh.attempt.result` records one-to-one; then a stats fixture that makes the deepseek rung qualify, a new mission, and an assertion that its `mesh.route.selected` names the new start. It finishes with the CLI verbs: `opensand mission reconcile` (no-op on a clean finish) and `opensand mission attempt restore` of a loser snapshot and of the kept attempt. The driver's state stays until the script cleans it up in an EXIT trap.
- **Usage**: `scripts/phase7-e2e.sh` (no arguments; builds the packages it needs).
- **Exit Codes**: 0 when all five checks (plus the CLI verbs) pass; non-zero on the first failed assertion, naming it.
- **Selftest**: the script is itself the check; the underlying runner behavior is covered by `packages/engine/test/mesh-tournament.test.ts` and the `mesh-routing-probe.sh` mutation probe.
- **Trigger**: Phase 7 S5 verification, automated job proof.

### `target-probe.sh`
- **Purpose**: The Phase 8 S2/S3 target probe (design §10 S2/S3), written as one command per mode. `container` builds the target bundle (`pnpm target:build`), writes a `targets.json` fixture with one `node:22-bookworm` container target into a temp home, and runs a node driver over the deployed bundle: the strict store loads the file and resolves the target, the launcher preflights node >= 22 in the image, starts the container with the workspace and read-only bundle mounted and network/privileges/pids capped, and over the stdio link asserts hello (platform linux, root /workspace, version match), an exec reporting Linux and `OPENSAND_TARGET_ID`, a write/read that round-trips through the bind mount to the host workspace, an outside-path refusal, and that the container is removed on exit. `ssh` resolves a real host the owner named (an ssh target from `$OPENSAND_HOME/targets.json`), preflights node >= 22, rsync and bwrap over ssh, deploys the bundle by content hash, proves a second lock holder is refused, pushes a temp workspace proving `.git` is excluded and an external symlink is refused before push, starts the persistent ssh link (hello root, marker exec), and proves the clean fetch+apply, the local-edit-after-push conflict and that a refused apply leaves the local bytes unchanged; it releases the lock and removes its probe dir on the host.
- **Usage**: `scripts/target-probe.sh container` (docker required; the image is pulled once, then cached). `OPENSAND_SSH_TARGET=<name> scripts/target-probe.sh ssh` (the named ssh target and the host's key setup are the owner's; no sshd on CI).
- **Exit Codes**: `0` when every check passes; `2` on usage error or when `ssh` mode runs without `OPENSAND_SSH_TARGET`; `3` when docker is unavailable in `container` mode; non-zero on the first failed assertion, naming it.
- **Selftest**: the script is itself the check; the underlying transport is covered by `packages/local-exec-daemon/test/target-transport.test.ts` (real child over stdio, no docker needed) and the sync layer by `packages/local-exec-daemon/test/target-sync.test.ts` (temp directory as the remote, no sshd needed).
- **Trigger**: Phase 8 S2/S3 verification, automated job proof.

### `mutation-probe.sh`
- **Purpose**: The one mutation probe. Applies a mutation to a file git tracks, requires the given test command to go RED, restores the file byte-for-byte (also on interruption), and requires GREEN again. A target git does not track is refused: a build artifact is not a real mutation, cannot be restored from git, and survives every incremental build.
- **Usage**: `scripts/mutation-probe.sh <file> <perl-substitution> -- <command...>` or `scripts/mutation-probe.sh <file> <line> <replacement> -- <command...>` (two arguments before `--` means a perl substitution, three means one line replaced). `--log <file>` writes the summary to a file.
- **Exit Codes**: `0` baseline GREEN, mutant RED, restored GREEN; `1` mutant survived or baseline/restore not green; `2` bad usage, untracked target, or a failed restore check.
- **Selftest**: `scripts/proof-selftest.sh`.
- **Trigger**: Selftest authors, QA / Release Engineer, automated job proof.

### `worktree.sh`
- **Owner Checkout Guard**: refuses (exit 4 with "worktree.sh: refusing to run from the owner's checkout; use ~/dev/_scratch/opensand-base") when `--git-common-dir` matches `$HOME/dev/opensand/.git` (or `OPENSAND_PROTECTED_CHECKOUT`). Overridden only with `OPENSAND_OWNER=1`.
- **Purpose**: Manage developer and agent worktrees in `~/dev/_scratch/` safely (`base`, `new`, `save`, `review`, `done`, `list`, `prune`). No command acts on the owner's main checkout `~/dev/opensand`: the current directory, the source repository's toplevel and every `new`/`review`/`done` target path are refused before anything happens, resolved through symlinks (`OPENSAND_ALLOW_MAIN_CHECKOUT=1` bypasses it for the selftest only). `base` creates or refreshes the reusable base clone (`OPENSAND_BASE_DIR`, default `~/dev/_scratch/opensand-base`, cloned from `OPENSAND_REPO_URL` or the current origin) and leaves it clean and detached at `origin/main`; `new` refreshes it and hangs the job worktree off it, so no throwaway clone in `/tmp` is needed. The base clone, and any clone that owns linked worktrees, is never removed, pruned or cleaned, and removal goes through the owning repository. `done` also drops the merged local branch so the job name is reusable (remote branches are never touched). `new` runs `scripts/worktree-prune.sh --apply` before the 3 GB free-space guard (`OPENSAND_WORKTREE_PRUNE_SCRIPT` overrides the path, and a prune failure never blocks creation). After creating a job worktree, `new` runs `scripts/setup-git.sh` there so rebases use the generated lessons-index merge driver. `prune` and `clean-disk.sh` never touch a *live* worktree (branch has an OPEN PR, or any file changed in the last 2 hours; rule in `scripts/lib/worktree-safety.sh`, which also fails closed when `gh` cannot be read).
- **`save "<message>" [-- <path>...]`**: run inside a job worktree to save work in one step. It stages by explicit path (the given paths, or every changed or new file listed one by one; ignored files stay out; never `git add -A`), **restores regenerated `packages/desktop/artifacts/*.png` to HEAD and prints what it skipped** (a full `verify.sh` rewrites them as a side effect; name one after `--` to commit a real screenshot change), refuses if the staged diff looks like a secret (`sk-`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `AKIA`, `BEGIN ... PRIVATE KEY`, and `.env`, `.env.*`, `*.env` files except `.env.example`, `.env.sample`, `.env.template`; the finding names file and line, never the value, and nothing is committed or pushed), commits with the repository's hooks ON (a failing hook means no push; there is no `--no-verify`), pushes the branch (never forced) and verifies the remote has exactly that commit. The first push opens a **draft** PR (`gh pr create --draft`); later saves reuse it. It refuses in the main checkout, the base clone, a plain clone, a detached HEAD, or on `main`. `new` only creates the worktree and branch: a branch with no commits cannot have a PR, so the draft opens on the first `save`. Run `gh pr ready <N>` when the work is ready; `pr-gate.sh` refuses drafts.
- **`done`** also refuses while HEAD holds commits that are on no remote branch (unpushed), naming `scripts/worktree.sh save`.
- **Usage**: `scripts/worktree.sh <base|new|save|review|done|list|prune> [args...]`
- **Exit Codes**: `0` on success, `1` on error or safety refusal.
- **Selftest**: `scripts/worktree-selftest.sh`.
- **Trigger**: Developer CLI, Gump/Rigel bot tasks, automation routines.

### `owner-guard-selftest.sh`
- **Purpose**: Hermetic selftest suite for the owner checkout guard (`scripts/lib/owner-guard.sh`). Verifies that `worktree.sh` and `pr-gate.sh` refuse (exit 4) when run from or linked to the owner's checkout (`$HOME/dev/opensand`), pass when run in an independent clone/worktree, and allow execution when overridden with `OPENSAND_OWNER=1`. Also verifies that removing the guard causes the refusal check to fail.
- **Usage**: `scripts/owner-guard-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, verification suite.

### `worktree-selftest.sh`
- **Purpose**: Hermetic selftest suite verifying the base clone, worktree creation (including the `df` stub proving the free-space guard measures the data volume), branch isolation, review worktree detachment, dirty/unmerged/unpushed refusal, pruning dry-run, and `save` (explicit-path staging, secret refusal per pattern with runtime-built fake tokens, hooks on, push verification, one draft PR).
- **Usage**: `scripts/worktree-selftest.sh`
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `worktree-prune.sh`
- **Purpose**: Reclaim whole scratch worktrees and stale temp folders before the disk fills. A worktree under `$OPENSAND_SCRATCH_DIR/opensand-*` is removed only when its branch has a merged PR (`gh pr list --state merged`) **or** was deleted on origin after merging, `git status --porcelain` is empty, and no file outside `.git` changed in the last 2 hours. `opensand-base`, `~/dev/opensand`, primary clones, the current worktree and any folder that is not a linked worktree are never touched; a `gh` or `ls-remote` failure fails closed. `$TMPDIR/opensand-*` folders older than 1 day are also removed. Reports free space before and after on the writable data volume (`df -k` via `scripts/lib/free-space.sh`).
- **Usage**: `scripts/worktree-prune.sh [--dry-run|--apply]` (`OPENSAND_SCRATCH_DIR`, `OPENSAND_TEMP_ROOT`, `OPENSAND_PRUNE_WINDOW_MIN`, `OPENSAND_TEMP_WINDOW_MIN` override the roots and windows; dry-run is the default; `worktree.sh new` calls `--apply` automatically).
- **Exit Codes**: `0` on success, `1` on bad arguments.
- **Selftest**: `scripts/worktree-prune-selftest.sh`.
- **Trigger**: `worktree.sh new` (automatic), manual invocation when disk is low.

### `worktree-prune-selftest.sh`
- **Purpose**: Hermetic selftest with a mock bare origin, a protected base clone and linked worktrees: merged+clean is removed, dirty is kept, recently changed is kept, unmerged is kept, base is kept, branch deleted on origin after merging is removed, a non-worktree folder and a linked worktree in TMPDIR are kept, stale temp folder is removed while a fresh one is kept, and `gh` failure keeps every worktree. Also checks CLI validation and the before/after disk report.
- **Usage**: `scripts/worktree-prune-selftest.sh` (`OPENSAND_PRUNE_SCRIPT` points at a mutant for a mutation proof).
- **Exit Codes**: `0` on success, `1` on failure.
- **Selftest**: Self-testing.
- **Trigger**: Pre-commit hook, test verification.

### `screen-kit.sh`
- **Purpose**: Phase 5 screen starter kit. Scaffolds one new screen for the Preact app shell so every remaining Phase 5 row starts from the same shape: the component `packages/desktop/renderer-next/src/views/<Name>.tsx` (loading / empty / ready / error+Retry states, keyboard-focusable rows, no fixed widths), its real-window test `packages/desktop/test/<kebab>-real-window.test.ts` (a real Electron window at 960x740 and 1920x1080, page pre-bundled with a throwaway vite build, screenshots captured into the gitignored `.opensand-snapshots/screen-kit/<kebab>/` folder -- screenshots are never committed), and the catalog rows in this README. Wiring the screen into `Shell.tsx` and giving it real data stays the row author's job.
- **Usage**: `scripts/screen-kit.sh <ScreenName>` (PascalCase); `scripts/screen-kit.sh --selftest` runs a hermetic selftest (temp-dir scaffold, catalog-row and refusal checks; no Electron).
- **Exit Codes**: `0` on success, `1` on refusal or selftest failure.
- **Selftest**: the `--selftest` flag (hermetic; the generated real-window test is exercised by the kit's sample run, not by CI).
- **Trigger**: Phase 5 row work.

### `Chat.tsx`
- **Purpose**: Phase 5 screen scaffolded by `screen-kit.sh`: component with loading / empty / ready / error(+Retry) states, keyboard-focusable rows, no small-screen overflow. Replace the demo `items`/`error` props with the row's real data source and wire it into `Shell.tsx`.
- **Usage**: `scripts/screen-kit.sh Chat`.
- **Exit Codes**: `0` on success, `1` on refusal (existing screen, non-PascalCase name, unknown flag).
- **Selftest**: chat-real-window.test.ts (real Electron window at 960x740 and 1920x1080; screenshots land in the gitignored .opensand-snapshots/screen-kit/chat/ folder, never committed).
- **Trigger**: Phase 5 row work.
