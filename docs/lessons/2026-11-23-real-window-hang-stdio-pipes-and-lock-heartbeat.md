# A real-window hang is a child holding stdio pipes, then a lock heartbeat that never goes stale

**Trap:** A diagnostic handle-dump timer loaded through NODE_OPTIONS fires in the long-lived `desktop-test.js` runner and shows a ChildProcess plus pipe handles; that is the normal in-flight child, not a leak. Separately, killing a stuck test leaves its Electron child (and helpers) alive, so the global `opensand-electron-tests.lock` keeps a fresh mtime from the orphan's heartbeat and every later real-window test waits until the 120 s ceiling.

**Root Cause:** The real-window tests resolve on `child.on("close")`, which waits for stdio EOF, not process exit; Electron helpers can keep those pipes open after the main process is gone. `McpClient.close()` sent only SIGTERM, so a child that traps it can block shutdown. A live-but-stuck lock holder defeats the 120 s staleness check because its heartbeat keeps rewriting mtime.

**Rule:** Resolve a spawned Electron wait on `exit` and release our stdout/stderr after a short grace (`whenElectronExited` helper), never on `close` alone. Send SIGKILL ~2 s after SIGTERM for MCP children. Scope diagnostic timers to the test-file child (skip processes whose argv contains `--test`) so a long-lived runner does not report a false hang.
