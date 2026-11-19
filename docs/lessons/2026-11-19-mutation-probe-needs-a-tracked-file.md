# A mutation probe refuses a brand-new file: it is not tracked until it is staged

- **Trap:** Running `scripts/mesh-judge-probe.sh` on a freshly written `judge.ts`
  failed with "refusing to mutate …: git does not track it", even though the file
  existed and the suite was green.
- **Root Cause:** `mutation-probe.sh` only mutates files `git ls-files` reports, because
  the restore is a byte-copy of a saved backup and an untracked (or gitignored, e.g.
  `dist/`) file cannot be proven restored and would poison incremental builds. A new
  source file is untracked until it enters the index.
- **Rule:** `git add` the new file before probing it. Staging is enough — `git ls-files`
  reads the index, so a staged-but-uncommitted file is a valid probe target.
