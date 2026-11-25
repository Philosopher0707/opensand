# Settings proof must use the production renderer

- **Trap:** The first model-dropdown screenshots were taken from renderer-next against mock data, while production still serves the legacy renderer unless `OPENSAND_RENDERER=preact`.
- **Root Cause:** The proof harness targeted the newer renderer because it was easier to mount in isolation, so it did not show the production modal, its field layout, or its real version source.
- **Rule:** Capture Settings proof in a real Electron window with the default legacy renderer, a temporary HOME and `--user-data-dir`; exercise Claude Code, OpenCode and OpenSand, and keep renderer-next tests as separate parity checks.
