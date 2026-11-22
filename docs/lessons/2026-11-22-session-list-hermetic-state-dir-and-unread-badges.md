# Session list hermetic state dir, unread badges, and reload persistence

- **Trap:** In real Electron integration test harnesses spawned under `hermeticElectronEnv(home)`, seeded sessions on disk in `home/.opensand/sessions` were not discovered by the backend bridge and remained empty in the UI.
- **Root Cause:** `os.homedir()` on POSIX/macOS resolves from system passwd (`getpwuid`) rather than `process.env.HOME`. The desktop app's `resolveStateDir` fell back to `path.join(os.homedir(), '.opensand')` unless `process.env.OPENSAND_STATE_DIR` was explicitly supplied.
- **Rule:** Hermetic Electron test harnesses spawning background instances must explicitly export `env.OPENSAND_STATE_DIR = path.join(home, ".opensand")` alongside `hermeticElectronEnv(home)` to ensure seeded mock sessions and configuration are loaded by the bridge and server.
