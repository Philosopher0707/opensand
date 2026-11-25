# Event-scoped secret scans keep unmerged branches out of main CI

**Trap:** With `fetch-depth: 0`, gitleaks scanned every fetched ref. A planted fake key on an unmerged PR branch therefore failed the security job for a push to `main`, even though main's history was clean.

**Root Cause:** The workflow used gitleaks without `--log-opts`, making the scan universe all refs in the checkout instead of the commits introduced by the current event. A local proof fixture also needs realistic runtime-generated entropy, and gitleaks' default summary does not name the finding's file or line.

**Rule:** Scan `origin/main` on pushes and the exact PR `base..head` range on pull requests. The local pre-push hook scans `remote..local` for an existing ref and the new ref's reachable history for a new branch; it requires gitleaks 8.30.1 and uses `--redact --verbose` for file/line evidence without printing candidate values. `scripts/pre-push-selftest.sh` builds its fake key at runtime, asserts the value never appears, asserts the workflow wiring, and proves main-only passes, PR-only fails, and the old all-refs scan fails for the same unmerged commit. Removing `--log-opts` from the workflow is a mutation-probed red case.
