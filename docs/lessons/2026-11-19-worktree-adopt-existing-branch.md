# worktree.sh cannot adopt an existing remote branch

- **Trap:** Landing PR #122 after main moved required a writable worktree at
  `job/phase7-p1-usage`, which already existed on origin. `scripts/worktree.sh new` refuses
  branches that already exist on the remote, and `scripts/worktree.sh review` only creates a
  read-only detached worktree — neither can attach a writable worktree to an existing branch, so
  the rebase had to fall back to a hand-made `git worktree add` from the base clone.
- **Root Cause:** The script covers the lifecycle "create a branch here, work, push" and has no
  command for "a branch already exists on origin (PR open, gate failed on CI): pick the job back
  up and rebase".
- **Rule:** When a job branch already exists on origin, create the writable worktree by hand from
  the base clone (`git -C "$HOME/dev/_scratch/opensand-base" worktree add <path> -b <branch>
  origin/<branch>`), run the rebase there, and push with `--force-with-lease`; do not run the
  rebase in `~/dev/opensand` or try to make `new` fit. Next time `worktree.sh` is touched anyway,
  add an `adopt <job-name>` subcommand that does this with the existing safety checks.
