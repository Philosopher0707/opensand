# Troubleshooting & Diagnostics

## OpenSand Doctor

Run the built-in diagnostic suite to verify daemon health, local model availability, and permissions:

```bash
opensand doctor
```

Or generate a structured JSON report for bug filing:

```bash
opensand doctor --json
```

## Common Issues & Fixes

### 1. "Ollama Unreachable (ECONNREFUSED 127.0.0.1:11434)"
- **Cause:** Local Ollama daemon is stopped.
- **Fix:** Launch Ollama from Applications or run `ollama serve` in a terminal window.

### 2. "Authentication Failed (401 Unauthorized)"
- **Cause:** The provider API key is missing or expired.
- **Fix:** Navigate to Settings in OpenSand and re-enter your API key.

### 3. "Execution Timeout"
- **Cause:** A long-running command (e.g. large build or test suite) exceeded the per-turn limit.
- **Fix:** Run large builds in a separate terminal or specify a timeout option.

### 4. "State Schema Downgrade Refused"
- **Cause:** The state directory was updated by a newer version of OpenSand.
- **Fix:** Update your OpenSand installation to match or exceed the version that created the state.

### 5. OpenSand.app does nothing when opened (no window, no dialog)
- **Cause:** The installed `.app` bundle is ad-hoc signed (no Apple Developer ID). On some macOS
  configurations AMFI/Gatekeeper silently rejects the process before a window is created
  (`AppleMobileFileIntegrityError Code=-423`, visible in `log show --predicate 'process == "amfid"'`),
  with no "Open Anyway" prompt in System Settings → Privacy & Security.
- **Fix:** Either sign the bundle with a real Developer ID certificate before installing, or clear
  the quarantine/signing block locally with `sudo xattr -cr /Applications/OpenSand.app` and
  `sudo spctl --add --label "OpenSand-local" /Applications/OpenSand.app` (admin password required).
- **Workaround for local development:** run the unpackaged app directly instead of the packaged
  bundle: `pnpm -C packages/desktop dev` (equivalent to `electron .` in that package). This uses
  Electron's own signed binary and is unaffected by the packaging signature. If your shell has
  `ELECTRON_RUN_AS_NODE=1` set (common in some sandboxed/agent environments), unset it first —
  otherwise Electron runs as plain Node and logs `Electron not detected`:
  `env -u ELECTRON_RUN_AS_NODE pnpm -C packages/desktop dev`.
