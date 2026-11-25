# A shared scratch worktree can be reset under a running job

- **Trap:** Mid-task, the assigned `~/dev/_scratch/opensand-base` worktree was detached back to `origin/main`; the edited `QuickOcr.tsx` disappeared from disk while the pushed branch still held the commit.
- **Root Cause:** The base worktree is shared by several bots; another job switched it to a detached review state. The branch and its remote commit were untouched, so no work was lost.
- **Rule:** Before editing in a shared scratch worktree, check `git status -sb`. If detached, `git switch <your-job-branch>` first and verify your newest commit is at HEAD; recover from the branch instead of rewriting files.
