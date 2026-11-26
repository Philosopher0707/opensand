# Release-test command mocks must live outside the clean fixture checkout

**Trap:** The direct-tag integration test put its fake `gh` executable under the synthetic repository, so release preflight correctly saw an untracked file and refused to create the test tag.

**Root Cause:** The test fixture combined repository contents and external-command mocks even though the release path requires a clean working tree.

**Rule:** Place fake executables and command logs in a sibling temporary directory, outside the Git checkout. Keep the fixture checkout clean so its real clean-tree and origin/main guards are exercised.
