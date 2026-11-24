# Real-window engine assertions must not assume which binaries are installed

- **Trap:** A Settings real-window test asserted that the `claude` option was disabled; it passed in CI but failed locally because that binary was installed on the developer's Mac.
- **Root Cause:** Passive detection reflects the host. A specific engine's installed state is not a stable assertion across machines.
- **Rule:** Assert the relationship instead: the count of disabled options equals the number of plain "is not installed" reasons, the default option is never disabled, and the selected value falls back to the default when needed. Verified in `packages/desktop/test/settings-welcome-real-window.test.ts` at 960x740 and 1920x1080.
