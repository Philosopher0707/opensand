# Mutation probe restore kept a stale build, so later probes read the previous mutant

- **Trap:** After `scripts/mutation-probe.sh` restored a source file, the "restored GREEN" run passed a stale `dist/` built from the mutant. A probe's baseline for the next file was therefore already mutated, and the summary reported `baseline is not green` or a result that belonged to the previous mutant.
- **Root Cause:** The restore uses `cp -p`, which keeps the backup's old mtime. `tsc -b` decides what to rebuild by mtime, saw the restored source as older than the mutant's output, and skipped it.
- **Rule:** A restore must touch the file so any incremental build sees it as new. `mutation-probe.sh` now runs `touch` after each restore. The probe's build command must also be run inside the probe, so each mutant is compiled from source, never from a previous `dist/`.
