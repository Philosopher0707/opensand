# Moving extraResources under mac is not enough to keep Mach-O out of a Linux build

- **Trap:** After moving `extraResources` under `mac:`, the real Ubuntu smoke still failed with `Mach-O content found in package: opt/OpenSand/resources/app/node_modules/@opensand/native-bridge/bin/sand-vision`.
- **Root Cause:** The macOS helper binaries are also checked into the `native-bridge` package's own `bin/` directory, so they arrive in the staged app through `node_modules` independently of `extraResources`. A config-only change to `extraResources` removes one copy, not the packed copy.
- **Rule:** Add a Linux-only files exclusion (`linux.files: ["!node_modules/@opensand/native-bridge/bin/**", "!**/node_modules/@opensand/native-bridge/bin/**"]`). electron-builder appends platform `files` patterns to the root ones, so macOS keeps its extraResources copy. The Mach-O gate in `smoke-linux.sh` is what actually catches the regression; keep it on the extracted package.
