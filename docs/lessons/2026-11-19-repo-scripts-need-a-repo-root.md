# A repo script run from an extracted copy fails: it cds to its own SCRIPT_ROOT

- **Trap:** Running `scripts/pr-gate.sh` from a copy of `scripts/` extracted into a plain temp
  directory failed with `gh pr view failed: fatal: not a git repository`, even though the same
  command worked when launched from a real job worktree.
- **Root Cause:** `pr-gate.sh` (and `worktree.sh`) resolve `ROOT` from their own path and
  `cd "$ROOT"` before running git/gh, so a copy outside a checkout runs every repo command in a
  non-repo directory.
- **Rule:** Never run repo scripts from an extracted copy in a bare temp dir. Attach a detached
  worktree of the base clone (`git -C "$HOME/dev/_scratch/opensand-base" worktree add <path>
  --detach origin/main`) and invoke the script from there, so `SCRIPT_ROOT` is a real checkout.
  Do this only to read/run scripts for a job whose worktree is gone; do the job's own work in a
  job worktree.
