# The scripts-catalog check reads every backticked *.ts in README.md as a script

- **Trap:** After cataloging `mesh-judge-probe.sh` in `scripts/README.md`, CI failed with
  "catalog lists 'judge.ts', but it does not exist in scripts/", even though the local
  verify ran before the push was fine on every real script.
- **Root Cause:** `check-scripts-catalog.sh` Check 2 greps the README for any backticked
  token matching `` `name.(sh|js|ts|bash|zsh)` `` and requires that file to exist under
  `scripts/`. Descriptive text that names a source file in backticks (e.g.
  `` `packages/engine/src/mesh/judge.ts` ``) is parsed as a catalog entry.
- **Rule:** In `scripts/README.md`, write paths to non-`scripts/` files without backticks
  (plain text), and run `SKIP_INSTALL=1 bash scripts/verify.sh` locally before pushing a
  catalog change — the same check that CI runs.
