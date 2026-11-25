# A verifier fixture went stale when verify.sh gained new checks

**Trap:** Before wiring the generated-index rebase test into `verify.sh`, `scripts/verify-selftest.sh` was already red with exit 127 because its fake workspace did not stub `check-hidden-window-spawns.sh` or `check-test-teardown.sh`. Adding another real call would only move the missing-file failure.

**Root Cause:** `make_workspace` listed the checkers verify.sh used when the fixture was written, but later verify checks were added without updating the fixture. The failure named the shell's missing file rather than the verifier contract that had drifted.

**Rule:** In the same change that adds a checker to `verify.sh`, add its fake-workspace stub and a marker-driven failing case to `scripts/verify-selftest.sh`, then run that selftest. This change restores the two missing stubs and adds the `lessons-merge-failing` case for the new rebase test. [checked: scripts/verify-selftest.sh healthy and lessons-merge-failing cases]
