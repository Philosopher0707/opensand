# A real-window timeout in the full suite that passes alone is contention, not proof

**Trap:** `verify.sh` failed on `navigation-real-window.test.js` with a 92 s render-frame timeout (the RAF promise was disposed) while every other package and test passed. The same test passed alone in 4.5 s, and the gate passed on the next run. Adding unrelated test files to the desktop package had not touched navigation code.

**Root Cause:** The desktop suite runs many Electron real-window files in parallel; under that load a frame can be disposed before the runner's requestAnimationFrame settles. A fixed-wait timeout then fires and the runner reports a lost frame, which looks like a product regression but is resource contention.

**Rule:** When a real-window test times out only in the full suite, keep the failing log and run that file alone before blaming the change. If it passes alone, name parallel Electron contention as the suspect and re-run the gate once; if it fails twice or fails alone, stop and report OPEN with the log instead of calling it a flake. A repeat becomes a check that records per-file timings for the real-window suite.

**Enforced (2026-11-22):** `scripts/desktop-test.js` runs non-real-window files in parallel, then each real-window file in its own process, logs a per-file wall-clock duration and fails by name above 120 s. [checked: scripts/desktop-test.js, scripts/desktop-test-selftest.js]
