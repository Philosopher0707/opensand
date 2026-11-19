# A full test run rewrites tracked screenshots, and `save` stages them

- **Trap:** `scripts/verify.sh` on a change that only touched the coordinator left three modified
  PNGs under `packages/desktop/artifacts/`. `scripts/worktree.sh save` (no paths) staged them, and
  `scripts/pr-gate.sh` Check 3 refused the PR as a binary file in the diff.
- **Root Cause:** `packages/desktop/test/window-harness.test.ts` writes real-window screenshots
  straight into the tracked `artifacts/` directory, so every run changes bytes the change never
  touched.
- **Rule:** After a full `verify.sh` in a worktree, run
  `git checkout origin/main -- packages/desktop/artifacts` before `save`, or pass the exact paths
  after `--`. The screenshots belong to a window change, never to a side effect of running tests.
- **Repeat (2026-11-19, phase 7 S3):** hit again from a local `verify.sh` during the judge PR;
  caught by pr-gate Check 3 before push... it had already been pushed once. Fixed (2026-11-19):
  `worktree.sh save` now refuses to stage `packages/desktop/artifacts/*.png` unless the path is named
  explicitly after `--`; it restores them to HEAD and prints what it skipped
  (see 2026-11-19-worktree-guards-main-checkout-and-artifacts.md).
