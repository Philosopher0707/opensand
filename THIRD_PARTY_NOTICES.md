# Third-party notices

OpenSand is licensed under the Apache License, Version 2.0 (see `LICENSE`).

## Runtime

OpenSand currently ships with **no third-party runtime dependencies**. Every
package in `packages/` depends only on other workspace packages.

## Build and development tooling (not redistributed)

| Component | License | Use |
|---|---|---|
| TypeScript | Apache-2.0 | Compiler |
| @types/node | MIT | Type declarations |
| pnpm | MIT | Package manager |

## Planned for packaged builds

When the desktop app is packaged (v1.0), it will bundle:

| Component | License | Use |
|---|---|---|
| Electron | MIT | Desktop runtime |
| Chromium | BSD-3-Clause and others | Renderer (via Electron) |

The distributed Electron and Chromium licence files must be included verbatim
in the packaged app before release. Until then, no Electron binary is bundled.

## System frameworks

`packages/native-bridge` compiles against Apple system frameworks (Vision,
Cocoa, CoreGraphics, ScreenCaptureKit) and links Swift runtime libraries. These
are part of macOS and are not redistributed.

## Provenance

OpenSand is an independent project. It is not affiliated with xAI, Anysphere, or
Grok Bot. Files that adapt third-party code carry an inline attribution comment;
see `docs/provenance-review.md` for the current inventory and review status.
