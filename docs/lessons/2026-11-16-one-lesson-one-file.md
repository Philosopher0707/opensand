# One lesson, one file: lessons no longer conflict

- **Trap:** Every PR appended its lessons entry to the end of `AGENTS_LEARNING.md`, so concurrent PRs conflicted on that file at merge time and each needed a hand-resolved append conflict.
- **Root Cause:** A single shared append-only file turns every pair of PRs into a merge conflict on the same last lines, and the conflict is pure bookkeeping.
- **Rule:** New lessons go in `docs/lessons/YYYY-MM-DD-slug.md`, one file each, with `# Title`, **Trap**, **Root Cause** and **Rule**. `scripts/lessons-index.sh` generates `docs/lessons/INDEX.md`, and `scripts/verify.sh` runs `scripts/lessons-index.sh --check`, which fails while the index is stale. `AGENTS_LEARNING.md` history (up to 12.34) is never rewritten; it ends with a pointer to this directory.
