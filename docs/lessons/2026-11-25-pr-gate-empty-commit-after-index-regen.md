# A regenerated lessons index can leave an empty commit that blocks the rebase

- **Trap:** `scripts/pr-gate.sh --when-green` regenerated a conflicted `docs/lessons/INDEX.md`, staged it, then `git rebase --continue` failed and the gate aborted, hiding the real error behind `>/dev/null`.
- **Root Cause:** When the regenerated index matches HEAD exactly, there is nothing to commit, so `git rebase --continue` refuses and the rebase stalls. The gate also discarded the command's stderr, so the cause was invisible.
- **Rule:** Capture and print `git rebase --continue`'s stderr; when it fails and the index is clean (`git diff --cached --quiet`), run `git rebase --skip` instead of aborting. Case 49 of `scripts/pr-gate-selftest.sh` covers the empty-commit path and fails on a gate that lacks the skip.
