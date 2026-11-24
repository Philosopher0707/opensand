# Full desktop suite can fail on a pre-existing navigation real-window timeout

- **Trap:** Running `pnpm --filter @opensand/desktop test` before the Phase 5 row 21 PR failed at
  `navigation-real-window.test.js`: the test itself reported a pass, but the harness logged
  `917.9s` against its `120s` per-file ceiling and exited 1. The two new sentinel tests passed on
  their own (model 5/5, real-window 1/1).
- **Root Cause:** The per-file watchdog did not terminate the child process group before the test's
  own slow wait finished, so wall-clock elapsed time — not the test result — decided the suite.
  This test is unchanged by the sentinel work; contention from other bots' Electron tests is a
  plausible contributor but was not verified.
- **Rule:** Do not rerun an unchanged full suite after this timeout. Run the touched test files
  directly (`node --test dist/test/<name>-model.test.js` and the single real-window file), record
  the pre-existing timeout in the PR body, and let QA own the navigation-test flake. Revert
  artifact PNGs rewritten by a full-suite run before committing a feature diff.
