# A lesson saved through worktree.sh could reach main with a stale index

- **Trap:** The quick-window PR (#119) failed CI twice on "docs/lessons/INDEX.md is stale". The lesson files were committed with `scripts/worktree.sh save`, which never regenerated the index, so the author had to run `scripts/lessons-index.sh` by hand and commit again.
- **Root Cause:** The index is a generated file, but `save` only staged, secret-scanned, committed and pushed. The regeneration step lived in the author's memory, not in the save path, and CI was the first thing to check it.
- **Rule:** `save` runs `scripts/lessons-index.sh` and stages `docs/lessons/INDEX.md` before the secret scan and commit; a failing script stops the save with nothing committed. `scripts/worktree-selftest.sh` test 11h covers both the regenerated index and the fail-closed case, and fails when the step is removed.
