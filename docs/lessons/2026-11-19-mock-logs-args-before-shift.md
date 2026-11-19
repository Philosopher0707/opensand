# A mock that logs call arguments must capture them before it parses them away

- **Trap:** A new selftest case asserting that all four download patterns were requested failed for every pattern even though the real call was correct. The mock `gh release download` logged `$*` after its argument-parsing loop had `shift`ed everything away, so the log line was empty.
- **Root Cause:** The assertion checked a diagnostic written by the mock after mutation of its own argument list, not the arguments the script actually passed.
- **Rule:** In a hermetic mock, record the raw invocation (`printf '%s\n' "$*" >> "$LOG"`) as the first statement of the branch, before any `shift`, then parse. Assert against that recorded call.
