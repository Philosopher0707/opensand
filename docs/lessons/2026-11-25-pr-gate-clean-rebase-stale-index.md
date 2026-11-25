# A clean rebase can still push a stale generated lessons index

- **Trap:** PR #255 rebased cleanly onto current main, but Linux and macOS CI failed because `docs/lessons/INDEX.md` was stale.
- **Root Cause:** The gate regenerated the index only when rebasing stopped on an index conflict. A clean rebase can change the lesson set without a conflict, so the pushed head never ran the generator.
- **Rule:** After every successful rebase, regenerate `docs/lessons/INDEX.md`, run its `--check`, and amend the rebased head when the generated file changed. Case 54 proves a clean rebase regenerates, stages, checks, and amends before the force-push.
