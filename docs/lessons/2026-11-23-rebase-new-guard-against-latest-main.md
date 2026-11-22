# A repo-wide guard passes on the branch but fails CI after the gate rebases it onto newer main

**Trap:** The new check-real-window-nav guard passed locally and on the PR's original base. The merge gate rebased the PR onto a main that had meanwhile merged a teammate's new real-window test with a direct hash assignment; CI went red on both jobs and the gate stopped before merging.

**Root Cause:** A check that scans every file in a class was validated only against the files present when the branch was created. Another lane's PR added a new file of that class after the branch point, so the guard's first real run against the rebased tree failed.

**Rule:** When adding a repository-wide guard, fetch the latest main before the PR and re-run the guard on a tree rebased onto it; if other lanes added covered files, convert them in the same PR. The gate's auto-rebase makes this a pre-gate step, not an optional extra. The guard itself is what surfaced the gap, so keep it in CI — no silent allowlist for files merged later. [checked: scripts/check-real-window-nav.sh]
