# Packaged app engine smoke testing requires canonical workspace trust and onboarding bypass

**Trap:** Testing outside coding agents in the packaged macOS desktop app headlessly hung on prompt submission, and initial app boot redirected to the `/welcome` screen instead of the main chat and settings interface.

**Root Cause:**
1. OpenSand's `FolderTrustStore` canonicalizes the active workspace directory. If the directory is not explicitly marked `trusted` in `folder-trust.json` inside `OPENSAND_STATE_DIR`, `sendQuery` pauses to prompt for user approval via IPC, causing headless queries to hang indefinitely.
2. In a clean, isolated state directory with no API key and no running Ollama server, `getOnboardingState()` redirects first-run navigation to `/welcome`.

**Rule:** Any automated or smoke harness launching the packaged app bundle in isolation must:
1. Canonicalize the temporary workspace folder with `fs.realpathSync.native()` and write `{ "version": 1, "folders": { [canonicalPath]: { "level": "trusted" } } }` to `$OPENSAND_STATE_DIR/folder-trust.json`.
2. Configure `config.json` with a non-Ollama local endpoint (e.g. `http://127.0.0.1:1234/v1/chat/completions`) so `needsOnboarding` evaluates to `false` and the app navigates directly to `/`.
3. Provide a repeatable smoke verification script (`scripts/engine-smoke.sh` and its selftest `scripts/engine-smoke-selftest.sh`).
