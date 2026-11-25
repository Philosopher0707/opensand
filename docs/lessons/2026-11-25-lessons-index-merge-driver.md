# A generated lessons index kept stopping rebases until Git owned its merge

**Trap:** Parallel PRs each added a lesson and regenerated `docs/lessons/INDEX.md`. Rebasing #248 and #255 stopped on that generated file, and the gate's one-conflict recovery aborted when a second generated-index conflict appeared later in the same multi-commit rebase.

**Root Cause:** Every branch rewrote the same index, so Git treated the generated output as source text. A custom driver also cannot simply run the normal generator against the worktree: Git's merge backend invokes the driver before checking out the incoming lesson file, and `%A` can be a temporary merge-result file rather than `docs/lessons/INDEX.md`.

**Rule:** Mark `docs/lessons/INDEX.md` with `merge=lessons-index`, register an idempotent driver from `scripts/setup-git.sh`, and call that setup from `scripts/worktree.sh new`. The driver uses `scripts/lessons-index.sh --merge %B > %A`: merge mode unions the current lesson files with the incoming generated index and emits bytes without modifying the worktree. Prove it with a hermetic two-branch, two-lesson rebase and remove the `.gitattributes` rule to verify the test fails red. [checked: scripts/lessons-index-merge-selftest.sh; scripts/lessons-index-selftest.sh stdout and merge cases; scripts/verify.sh]
