# A lease file inside the attempt worktree would dirty every snapshot

- **Trap:** Phase 7 S2 (mesh tournament worktree lifecycle, design §4.4) places the
  attempt lease at `attempts/<n>/lease.json` — inside the attempt worktree. Any file
  inside the tree shows up in `git status`, so every attempt would be permanently
  "dirty": snapshots would carry the lease, the dirty check for keep/remove would
  always report dirty, and `git worktree remove` without `--force` would always fail.
- **Root Cause:** The design treats `attempts/<n>/` both as the worktree and as a
  per-attempt state directory; those are the same directory, so a state file there
  pollutes the tree it describes.
- **Rule:** Keep per-attempt state files next to the tree, not inside it:
  `attempts/<n>.lease.json`. If the design is ever revised, do not move state back
  inside the worktree; if a directory per attempt is really wanted, the worktree and
  its state dir must be siblings. Related platform note: liveness needs the process
  start time — Linux `ps -o etimes=` works, macOS has no `etimes`, so parse
  `ps -o lstart=` with `LC_ALL=C`.
