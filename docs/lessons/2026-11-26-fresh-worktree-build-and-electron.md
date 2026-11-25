# A fresh worktree needs workspace builds and a linked Electron binary

- **Trap:** In a new worktree, `pnpm --filter @opensand/desktop... run build:tsc` failed with missing `@opensand/*` exports, and real-window tests would have tried to download Electron because the package had no `path.txt`/binary.
- **Root Cause:** Dependency packages define only `build` (not `build:tsc`), and `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --offline` installs the Electron package without its cached `dist` link.
- **Rule:** Build with `pnpm --filter @opensand/desktop... run build`; before any real-window check, link the same-version cached Electron `dist` and copy its `path.txt` into the worktree's `.pnpm/electron@<version>/node_modules/electron`, then confirm `dist/$(cat path.txt) --version` prints the expected version.
