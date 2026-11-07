# Installing OpenSand

OpenSand is a local, privacy-first AI engineering agent built for macOS.

## System Requirements

- **Operating System:** macOS 14 (Sonoma) or newer (Apple Silicon arm64 or Intel x64).
- **RAM:** Minimum 8 GB (16 GB+ recommended for local LLM inference).
- **Storage:** ~300 MB for the OpenSand desktop application.

## Desktop Application (.dmg)

1. Download the latest `OpenSand-<version>-arm64.dmg` from the GitHub Releases page.
2. Double-click the downloaded `.dmg` file.
3. Drag **OpenSand** into your **Applications** folder.
4. Launch OpenSand from Applications or Spotlight (`Cmd + Space` → `OpenSand`).

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
