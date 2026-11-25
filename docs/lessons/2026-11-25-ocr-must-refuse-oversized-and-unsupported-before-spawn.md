# OCR must refuse oversized and unsupported images before spawning sand-vision

- **Trap:** A 21 MiB non-image file and an unsupported-format image reached the real `sand-vision` helper and returned a generic `sand-vision exited with code 1` instead of a pre-scan size/format rejection; the helper's structured stdout error was also discarded on nonzero exit.
- **Root Cause:** `packages/native-bridge/src/vision-ocr.ts` checked only file existence before spawn, with no byte or type cap; on nonzero exit it read only stderr, discarding the helper's stdout JSON. The renderer classifier therefore could not map the real rejection.
- **Rule:** Check file size (20 MB cap) and image magic bytes before spawning the helper; on nonzero exit, parse structured stdout before falling back to stderr. Add a native-bridge integration test with a real executable probe asserting the probe is never invoked, and mutation-test the guard.
