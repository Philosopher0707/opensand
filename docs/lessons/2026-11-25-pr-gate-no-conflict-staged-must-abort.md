# A rebase that stops with staged changes but no conflicts must abort, not be treated as complete

- **Trap:** `scripts/pr-gate.sh` treated "no conflicts + staged changes" as a completed rebase and force-pushed a partially rebased branch; a `grep -c . || echo 0` also printed `0\n0`, causing a syntax error.
- **Root Cause:** The recovery loop set `REBASE_DONE=1` whenever there were no unmerged paths and the staged tree was non-empty, which is exactly what happens when a commit hook rejects a commit. The count used `grep -c . || echo 0`, which prints an extra 0 on empty input.
- **Rule:** A no-conflict state with staged changes aborts with `git rebase --abort`, stderr printed and no push/tag/merge; only an empty staged state is skipped. Count conflicts with `grep -c . || true`. Also verify `rebase-merge`/`rebase-apply` are gone before any push.
