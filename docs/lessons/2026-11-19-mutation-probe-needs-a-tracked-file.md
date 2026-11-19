# scripts/mutation-probe.sh refuses untracked files — commit the slice before probing

- **Trap:** Phase 7 S4 ran its new mutation probe before the first commit. The
  generic probe aborted with "refusing to mutate …: git does not track it",
  before any mutation happened.
- **Root Cause:** The probe restores the mutated file with git, which is only
  verifiable for a tracked file; an untracked source file cannot be restored
  byte-for-byte that way.
- **Rule:** Run the mutation probe after the code is committed (a local commit
  is enough; `worktree.sh save` can still push and open the PR afterwards).
  Put the probe script itself in that commit so the probe's own file is
  tracked too.
