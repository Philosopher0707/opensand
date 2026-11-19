# Attempt restore deletes only files covered by later mission snapshots

- **Trap:** The Phase 7 S5 e2e restored the kept attempt (a tree without
  `extra.txt`) over a workspace where the loser's snapshot restore had brought
  `extra.txt` back, and asserted the file disappeared. It stayed.
- **Root Cause:** `computeFilesToDelete` (the engine's Phase 2/3 restore rule)
  deletes only files that belong to later `s-<seq>` mission step snapshots of
  the same mission. A raw commit-tree restore carries no seq, and an untracked
  stray introduced by a different ref is not a later snapshot file, so it is
  left on disk on purpose.
- **Rule:** Assert what restore guarantees: the target tree's content is
  present and correct. Never assert that an untracked stray introduced by a
  different snapshot disappears; clean the workspace between restore scenarios
  instead.
