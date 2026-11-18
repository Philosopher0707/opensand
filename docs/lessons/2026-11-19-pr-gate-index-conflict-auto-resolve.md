# PR #124's rebase always conflicted on the generated lessons index

- **Trap:** Every live auto-rebase of a PR behind origin/main stopped on `docs/lessons/INDEX.md`, so the gate printed a conflict and someone had to resolve a generated file by hand.
- **Root Cause:** Two PRs each add a lesson and regenerate the index, so the same generated line changes on both sides. The conflict carries no real decision, but the gate treated it like any other conflicting file.
- **Rule:** When the only conflicting file is `docs/lessons/INDEX.md`, `scripts/pr-gate.sh --when-green` regenerates it with `scripts/lessons-index.sh`, re-checks that it is current, stages it and continues the rebase. Any other file, a generator error, or a still-stale index aborts with the file list and no push. `scripts/pr-gate-selftest.sh` cases 25-27 cover resolve, mixed conflict and fail-closed stale; the mutation probe fails case 25 when the step is removed.
