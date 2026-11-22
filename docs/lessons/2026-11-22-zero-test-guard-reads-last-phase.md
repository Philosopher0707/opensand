# The zero-test guard must not read only the last phase of a multi-phase runner

**Trap:** After the desktop suite was split into a parallel phase and a serial real-window phase, Linux CI failed `verify.sh` with "Package @opensand/desktop … reported 0 tests" even though 71 test files ran. macOS CI passed.

**Root Cause:** On Linux CI every real-window test skips (no `DISPLAY`/`WAYLAND_DISPLAY`), so each phase-2 invocation ends with `# pass 0`. The guard took the *last* `(tests|pass) N` line in the log, which was one of those zeros.

**Rule:** A zero-test guard is a per-package "did any tests run?" check, so take the largest count in the log (`sort -nr | head -n 1`), never the last. When a test script gains a second phase, check the guard against the platform where that phase is all skipped, not only the one where it passes.
