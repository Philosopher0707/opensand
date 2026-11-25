# Unpackaged Electron reports the Electron binary version, not the app version

- **Trap:** The real legacy Settings footer showed `OpenSand v45.2.3` in a development Electron window instead of the desktop package version.
- **Root Cause:** `app.getVersion()` returns Electron's own version when the app is launched through the bare Electron binary; it returns the packaged app version only in a packaged build.
- **Rule:** When `app.isPackaged` is false, read `packages/desktop/package.json` relative to `import.meta.url`; use `app.getVersion()` only for packaged apps. Keep a unit test and a real-window assertion for the exact `OpenSand v<package version>` footer.
