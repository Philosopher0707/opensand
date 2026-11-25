# Engine detection tests must isolate host CLIs

## Notes

- **Trap:** A detector route test hung while checking the new model discovery path, including after the detector was replaced in the test.

- **Root Cause:** The first version let production coordinator construction start in the test, and detector-only probes can also discover binaries in standard install folders even when `PATH` is replaced. This made a test depend on host CLI behavior and setup latency.

- **Rule:** Keep the HTTP projection test at the route seam with a deterministic detection result, test provider and CLI adapters through injected transports, and test the production saved-model mapping directly instead of constructing a live turn coordinator.
