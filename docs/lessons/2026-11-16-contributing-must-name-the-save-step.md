# The contributor guide must name the save step, or agents will not run it

- **Trap:** `worktree.sh save` existed, was selftested and was listed in the scripts catalog, but CONTRIBUTING.md never told a contributor to run it after a green step, and its command table did not list `save`. A finished step could stay unsaved on the disk.
- **Root Cause:** The tool was added and tested, and its docs were written in the script header and the scripts README only. Nothing checked that the workflow guide, which agents read first, mentioned the step.
- **Rule:** Every save, gate or lifecycle step a contributor must run is named in CONTRIBUTING.md's Workflow rules and its Commands table. The check is Check 4 of `scripts/check-scripts-catalog.sh` (run by `scripts/verify.sh`): it fails when CONTRIBUTING.md does not name `scripts/worktree.sh save` or `scripts/pr-gate.sh`; its selftest case 6 proves that. Add a step to its list when a new one becomes mandatory.
