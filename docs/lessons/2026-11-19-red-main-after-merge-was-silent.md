# Red main after a merge was silent

**Trap:** The merge gate proved PR CI green before merging, then exited 0. If the CI run on main failed after the merge (process map node 22), nobody was told: the red main sat unnoticed until a later job happened to look.

**Root Cause:** The gate's last act was `gh pr merge` plus printing the merge commit. It watched CI only *before* the merge (`--when-green`); nothing watched the run that the merge itself triggers on main, and a successful exit status claimed everything was fine.

**Rule:** `scripts/pr-gate.sh` waits for the main CI run of the merge commit after every merge, with the same bounded `--timeout` deadline as `--when-green` (a run that has not registered yet is pending, not red). Green prints `main CI green for <sha>` and exits 0; red names the failing jobs and prints `gh run view <id> --log-failed` and exits 4; a pending/no-run timeout exits 3. `--no-post-merge-check` opts out. Selftests cover green/red/no-run/opt-out and a mutation removing the red branch makes the red case fail.
