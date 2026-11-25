# The gate must recover INDEX.md conflicts on every commit of a multi-commit rebase

- **Trap:** After #259, Atlas's gate recovered the first `docs/lessons/INDEX.md` conflict but aborted on the second one in the same rebase, leaving the PR behind.
- **Root Cause:** The recovery block ran once inside a single `if ! git rebase` invocation; `git rebase --continue` can stop again on the next commit's conflict, and the gate treated that as a fatal failure.
- **Rule:** Wrap the rebase in a loop: while in progress, regenerate INDEX.md on an INDEX-only conflict, skip empty commits, and abort only on a non-INDEX conflict or the attempt bound. Case 50 (3 commits, one empty) and case 51 (real conflict on the 2nd commit) cover both paths.
