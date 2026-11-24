# Chat turn polish: worktree entry point, build order and escape-rule ordering

- **Trap:** `bash scripts/worktree.sh new chat-turn-polish` failed from the owner checkout: `scripts/worktree.sh` and `scripts/pr-gate.sh` do not exist on the branch checked out there (`feat/agent-settings-ui`). The first attempt also reported the reusable base clone as dirty even though `git status --porcelain` was empty on a direct check.
- **Root Cause:** The lifecycle scripts live on `origin/main`, which the base clone is pinned to; the owner checkout is on an older feature branch and its lockfile is locally modified. The dirty report was transient, observed while `clean-disk.sh --yes` was reclaiming space for the same command.
- **Rule:** Run `worktree.sh` from `~/dev/_scratch/opensand-base` (which is at `origin/main` and owns the scripts), never from `~/dev/opensand`. If it reports a dirty base, check `git -C <base> status --porcelain` directly and retry once before treating it as a blocker.

- **Trap:** A fresh worktree had no `node_modules` and `tsc -b` of the desktop package failed on missing `@opensand/*` declarations; the new unit tests also failed to compile before any implementation existed.
- **Root Cause:** Worktrees share the pnpm store but not installed dependencies or `dist/`, and desktop's types resolve to sibling packages' build output.
- **Rule:** In a new worktree run `pnpm install --frozen-lockfile` then `pnpm -r run build` once before the red/green loop; build only `@opensand/desktop` for subsequent test iterations.

- **Trap:** The ANSI parser's single-character escape rule (`ESC [@-_]`) was placed before the incomplete-CSI rule and consumed `ESC [`, leaving the digits as visible text (`before31`); a test fixture also had a stray literal `c` after an OSC terminator and was blamed on the parser.
- **Root Cause:** Regex alternatives were ordered from loose to specific, and the fixture mixed OSC-8 link text with the terminator.
- **Rule:** Order escape alternatives most-specific-first (SGR, OSC, complete CSI, incomplete CSI, then single-character). Keep the regression test for a truncated `ESC [31` and check the fixture bytes before changing the parser.

- **Trap:** The new stop→resume real-window test passed but took 119s, then 237s on later runs, and a whole-file run exceeded a 10-minute shell timeout; a diagnostic run failed with `[runner] timeout` and `Render frame was disposed before the request completed`.
- **Root Cause:** Electron real-window tests share a global mkdir lock in `/tmp` with other worktrees. Another bot was launching its own Electron tests concurrently, so `withElectronLock` waited while the runner's own 150s deadline started only after the lock was acquired. An open SSE stream from the resumed turn also kept the stub server's `close()` waiting.
- **Rule:** When a real-window test resumes a streaming turn, stop it again before quitting so the stub's connection closes. Attribute multi-minute wall times to lock contention before changing assertions: check `/tmp/opensand-electron-tests.lock` and other bots' Electron processes, then re-run the single test with `--test-name-pattern`. Keep the assertions unchanged when the test itself passes.

- **Trap:** The required `TMPDIR=$(mktemp -d) SKIP_INSTALL=1 bash scripts/verify.sh` failed twice on two different *untouched* real-window files (`chat-history`, then `account-shortcuts`) at the 120s per-file ceiling, while the same whole suite passed with `OPENSAND_REAL_WINDOW_LIMIT_MS=300000` (my changed file took 20.2s).
- **Root Cause:** All real-window files across worktrees serialise on one `/tmp` mkdir lock; a concurrent bot's Electron run starves whichever file waits next, and the 120s ceiling counts the wait.
- **Rule:** When verify fails on a real-window file you did not change, check the global lock and other bots' Electron processes before editing tests. Keep one raised-ceiling green run as evidence, let isolated CI give the authoritative result, and stop after two such failures instead of retrying.

- **Trap:** `check-dead-exports.sh` reported five new dead exports although all five are imported by `Chat.tsx`.
- **Root Cause:** The checker scans only `packages/*/src` for findings *and* references; `renderer-next/src` is outside that scan, so view-only helpers look unused (210 desktop entries are already seeded for the same reason).
- **Rule:** Add view-only shell helpers to `scripts/dead-exports-allow.txt` in sorted order and keep the unit tests as the proof they are exercised.

- **Trap:** Repeated local real-window runs popped Electron windows on the owner's screen and blocked their work; my own multi-minute runs were caused by another bot's competing Electron tests, so retrying made the screen problem worse.
- **Root Cause:** Every `*-real-window.test.ts` launches a visible Electron window by design, and the default `pnpm test` / `verify.sh` runs them locally. A shared `/tmp` lock only serialises them; it does not hide them.
- **Rule:** Never launch OpenSand/Electron windows on the owner's Mac for verification. Mark new real-window tests "CI only until hidden-window mode lands" (skip unless `CI`/`GITHUB_ACTIONS` is set), commit with `OPENSAND_PRECOMMIT_TEST_CMD` pointing at a runner whose `OPENSAND_DESKTOP_TEST_DIR` excludes `*-real-window.test.js`, and use GitHub CI as the authoritative proof. Never use `--no-verify`.
