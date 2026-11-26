# Electron real-window tests need the executable, not the npm shell shim

- **Trap:** The macOS account Settings real-window test exited 127 before opening a window: the `.bin/electron` launcher could not find `sed`, `dirname`, `uname` or `node`.
- **Root Cause:** The test intentionally gives the child process a fake-only `PATH` to prevent discovery of real CLI accounts. The npm launcher is a shell script that itself needs those PATH tools, even though Electron's installed executable is available by absolute path.
- **Rule:** Resolve Electron's executable from its package with `createRequire(import.meta.url)("electron")`, spawn that absolute path, and keep the fake-only PATH. This preserves CLI isolation and launches the real Electron window. In a fresh worktree, build the desktop package's workspace dependency closure before the targeted proof: `pnpm --filter @opensand/desktop... build`.
