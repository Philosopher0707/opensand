# A phase done-when named a suite that no phase had built

- **Trap:** The Phase 8 roadmap row in `docs/design/opensand-next.md` says "per
  target: the phase-3 mission suite passes on it", but no phase-3 mission suite
  existed. `grep -rn "mission suite" docs scripts evals` returned only the
  roadmap row itself; `scripts/phase7-e2e.sh` was the only end-to-end mission
  driver. Writing the Phase 8 design against that wording would have produced a
  gate nobody could run.
- **Root Cause:** The roadmap was written before Phase 3 and named an artifact
  that Phase 3 never shipped; each later phase's "done when" was copied forward
  as prose without checking that the cited command or suite exists and runs.
- **Rule:** Before writing a phase document whose done-when cites an earlier
  phase's artifact, grep the repository for that artifact and run it (or prove
  it absent). If it is absent, the new phase owns creating it as its first
  slice and says so under a "gap found while writing this doc" heading.
