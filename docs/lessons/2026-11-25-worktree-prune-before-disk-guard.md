# Prune whole worktrees before the disk guard, not just their caches

**Trap:** The Mac's data volume hit 100% on 24 Nov 2026 and again on 25 Nov (872 MB free). `worktree.sh new` refuses below 3 GB, which stalled Pixel. Removing 23 clean worktrees of merged PRs by hand freed about 7 GB, and stale OpenSand temp folders in `$TMPDIR` freed about 3 GB more.

**Root Cause:** Cleanup only removed `node_modules`/`dist` inside worktrees (`clean-disk.sh`) and `worktree.sh prune` was a manual opt-in. Nothing removed the finished worktrees themselves or the old temp folders, so the space stayed occupied until someone did it by hand.

**Rule:** Run `scripts/worktree-prune.sh --apply` automatically at the start of `worktree.sh new`, before its 3 GB guard. Remove a scratch worktree only when its branch is a merged PR or was deleted on origin after merging, it is clean, and nothing outside `.git` changed in the last 2 hours; also remove `$TMPDIR/opensand-*` folders older than a day. Never touch the base clone, the owner checkout, primary clones, non-worktrees or the current worktree; fail closed when GitHub/origin cannot be read. Manual runs default to dry-run and report free space before and after. Regression: `scripts/worktree-prune-selftest.sh`.
