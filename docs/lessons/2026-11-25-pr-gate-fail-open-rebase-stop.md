# A rebase stop with no conflicts is not a finished rebase

- **Trap:** `scripts/pr-gate.sh` treated "no unmerged files + staged changes" as
  a completed rebase and went straight to `push --force-with-lease`, tag and
  merge. When a commit hook rejected a commit, Git left staged changes with no
  conflict markers, so the gate could drop the unapplied commit from the remote
  branch. In the same path `grep -c . || echo 0` printed `0` and then `0` again,
  so `[[ "$CONFLICT_COUNT" -gt 0 ]]` raised `syntax error` before the bad
  completion branch. Vega reproduced both on PR #260 head `8be296b`.
- **Root Cause:** completion was inferred from the absence of a failure signal
  (no conflicts) instead of positive proof that the rebase ended. `grep -c`
  exits 1 when it counts zero but still prints `0`, so `|| echo 0` appends a
  second one.
- **Rule:** before any push from a recovery loop, require positive evidence the
  operation finished (no `rebase-merge`/`rebase-apply` state) and abort on any
  stop the loop does not recognise, printing the original stderr. Count with
  `grep -c ... || true`, never `|| echo 0`. The regression asserts no push, tag
  or merge in addition to the exit code: an exit-code-only test passes while the
  branch is already overwritten.
