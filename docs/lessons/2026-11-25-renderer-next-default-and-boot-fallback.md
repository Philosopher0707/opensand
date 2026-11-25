# Renderer-next default: packaging and boot-failure hurdles (2026-11-25)

**Trap:** A worktree whose `node_modules` were symlinked to the shared main checkout compiled `@opensand/desktop` against stale workspace `dist` types (dozens of "has no exported member" errors) although the branch was current.
**Root Cause:** The symlinked workspace packages resolve to the main checkout's `dist`, which other agents rebuild from different branches, not to this worktree's sources.
**Rule:** Give each worktree its own `pnpm install --offline --frozen-lockfile --ignore-scripts` (pnpm hardlinks from the local store, so it is cheap) before `pnpm --filter @opensand/desktop... run build`.

**Trap:** A built `renderer-next/index.html` can omit its own JS and leave a blank window; the server-side fallback only covers a missing `index.html`.
**Root Cause:** `resolveRendererDir` checks for `index.html` on disk, not whether the Preact app actually mounted.
**Rule:** Keep the classic `public/boot-fallback.js` script referenced from `renderer-next/index.html` so an `error`, `unhandledrejection` or a never-mounted `#root` produces a visible plain message with the `OPENSAND_RENDERER=legacy` recovery path; cover it with a DOM-stub test.

**Trap:** Checking `dist/stage` alone does not prove what a user sees; a packaged build can ship the legacy renderer while the repo defaults to the new one.
**Root Cause:** The renderer choice is made at runtime from the bundle's own `dist` tree, which a staging check does not exercise.
**Rule:** Build the real zip, launch its executable with an isolated `HOME`, `OPENSAND_STATE_DIR` and `--user-data-dir`, drive it over `--remote-debugging-port`, and capture main/Settings/Phase 5 screenshots from the packaged window. Renaming `dist/renderer-next` inside the unpacked zip logs `dist/renderer-next is missing … Using the legacy renderer` and shows the legacy UI, not a blank window.
