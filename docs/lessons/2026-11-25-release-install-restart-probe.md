# Release install left old app running until quit, relaunch, and live probe were gated

- **Trap:** `scripts/release.sh --install` unpacked the new app bundle to `/Applications/OpenSand.app` and ran `install-health-check.sh` on an isolated temporary instance, but never stopped any currently running OpenSand process or relaunched the installed app. Users running OpenSand continued executing the old version indefinitely after the release script claimed success (hotfix failure mode (a)).
- **Root Cause:** The install step assumed file copying was equivalent to deployment, ignoring macOS app process residency. Without gracefully terminating the old process and actively verifying the relaunched app over its live REST API, an install could succeed while the user experience remained stale.
- **Rule:** In `scripts/release.sh --install`:
  1. Gracefully terminate any running OpenSand app (`osascript -e 'tell application "OpenSand" to quit'`), wait up to 15s, and fall back to `kill -TERM` only for the OpenSand.app process if still running.
  2. Install the new bundle and relaunch with `open -a "$APP_DEST"`.
  3. Probe the live running process: resolve port (via `server.port`, `lsof` on app pid, or default 3456) and token (`~/.opensand/server.token` without printing it). Require `GET /api/version` to match the release tag and `GET /api/engines/detect` to return HTTP 200 with a non-empty list within 30s. Fail closed if mismatched or unresponsive.
  4. Verify hermetically via `scripts/release-install-restart-selftest.sh` using stubs: prove a stale-version stub fails red and a matching one passes green.
  [checked: scripts/release-install-restart-selftest.sh; scripts/release-selftest.sh; scripts/check-scripts-catalog.sh; scripts/verify.sh]
