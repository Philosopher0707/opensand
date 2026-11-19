# Phase 8 parallel lanes share package.json and scripts/README.md — compare file lists before launching them

- **Trap:** Phase 8 runs S2 (target bundle, container target) and S5 (Linux
  build) as parallel lanes. Both lanes touch `package.json` (S2 adds
  `target:build`, S5 adds `package:linux`) and `scripts/README.md` (S2 catalogs
  `target-probe.sh`, S5 catalogs `smoke-linux.sh`), and both edit
  `pnpm-lock.yaml`-adjacent manifests. Two lanes that commit these files at
  different times produce rebases where the second PR's diff carries the first
  lane's rows, or a merge conflict inside a one-line JSON block.
- **Root Cause:** The lane briefs name only their own files. Nothing compares
  the two lanes' file lists for overlap, so the shared manifests are discovered
  as conflicts during the second rebase instead of being sequenced on purpose.
- **Rule:** Before starting parallel lanes, diff each lane's file list against
  the others'. Any file shared between two lanes gets a rule: either serialize
  those files (the later lane rebases on the merged first lane before editing
  them) or assign one lane to own the file and let the other send its row to
  it. A shared manifest without an ordering is a guaranteed rework loop.
