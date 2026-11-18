# docs/lessons/INDEX.md is generated, so a hand edit makes the shared suite fail

- **Trap:** I added two lesson rows to `docs/lessons/INDEX.md` by hand. The shared package's `verify.sh` test then failed with `docs/lessons/INDEX.md is stale`, and the pre-commit hook blocked the commit.
- **Root Cause:** The index is written by `scripts/lessons-index.sh` from the lesson files, sorted by name. A hand edit is never the same as the generated output.
- **Rule:** Add the lesson file, then run `bash scripts/lessons-index.sh` and commit its output. Never edit `INDEX.md` by hand.
