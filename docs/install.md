# Installing OpenSand

OpenSand is a local, privacy-first AI engineering agent built for macOS and Linux (x86_64).

## System Requirements

- **Operating System:** macOS 14 (Sonoma) or newer (Apple Silicon arm64 or Intel x64), or a 64-bit Linux distribution (glibc from Ubuntu 22.04 or newer).
- **RAM:** Minimum 8 GB (16 GB+ recommended for local LLM inference).
- **Storage:** ~300 MB for the OpenSand desktop application.

## Desktop Application (.dmg)

1. Download the latest `OpenSand-<version>-arm64.dmg` from the GitHub Releases page.
2. Double-click the downloaded `.dmg` file.
3. Drag **OpenSand** into your **Applications** folder.
4. Launch OpenSand from Applications or Spotlight (`Cmd + Space` → `OpenSand`).

## Linux (x86_64)

Two unsigned Linux artifacts are published for every release:

- **`OpenSand-<version>-x86_64.AppImage`** — portable; no installation required:
  ```bash
  chmod +x OpenSand-<version>-x86_64.AppImage
  ./OpenSand-<version>-x86_64.AppImage
  ```
- **`OpenSand_<version>_amd64.deb`** — install with `sudo apt install ./OpenSand_<version>_amd64.deb`, then launch **OpenSand** from your application menu.

Linux builds ship without the macOS native helpers and are not signed or notarized.

Release integrity is checked before publishing with `bash scripts/smoke-linux.sh dist/release/*.deb`. It extracts the `.deb`, launches the packaged binary under a virtual display with isolated state, checks that `/api/diagnostics` reports the bundled version, and fails if the package contains any macOS Mach-O binary. You can run the same check on a downloaded `.deb` (requires `xvfb-run`, `curl` and `dpkg-deb`).

## Command-Line Interface (CLI)

OpenSand also includes a terminal client:

```bash
# If using the packaged binary
sudo cp /Applications/OpenSand.app/Contents/Resources/bin/opensand /usr/local/bin/

# Or via pnpm in local development
pnpm --filter @opensand/cli build
pnpm link --global packages/cli
```

Verify your installation:

```bash
opensand doctor
```
