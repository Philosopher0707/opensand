# Clean-disk wipes workspace dist; Electron's module import then hangs instead of failing

- **Trap:** After `scripts/clean-disk.sh` had deleted `node_modules` and `dist` across
  `~/dev/_scratch/*` (98%-full disk), a fresh `pnpm install` restored dependencies but not
  the workspace packages' build output. Real-window tests then hung forever: the Electron
  child sat inside `LoadEnvironment` (importing `packages/desktop/dist/src/main.js`), with
  no error, no exit, and no output. Sampling the process showed only module-loader frames.
- **Root Cause:** `@opensand/coordinator/dist/src/index.js` (and the other workspace
  packages' `dist`) did not exist after the cold install. Electron's ESM loader never
  rejects such an import — the missing module surfaces as a silent hang, not as
  ERR_MODULE_NOT_FOUND (which plain Node does produce for the same import).
- **Rule:** After any clean-disk or cold reinstall in a scratch worktree, run
  `pnpm --filter @opensand/desktop... run build` before any real-window test. A test can
  make this fail fast: extend the real-window skipReason to check that the workspace
  dependencies' dist exists (e.g. `packages/coordinator/dist/src/index.js`) and skip with
  "workspace dist missing — run pnpm --filter @opensand/desktop... run build".
