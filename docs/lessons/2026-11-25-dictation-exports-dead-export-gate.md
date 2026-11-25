# renderer-next imports are invisible to the dead-export gate (2026-11-25)

**Trap:** PR #257's CI failed on both Linux and macOS with "4 NEW dead export(s)" for `DICTATION_LABELS`, `createDictationController`, `dictationNotice` and `dictationText`, even though the renderer-next composer and tests import all four.

**Root Cause:** `scripts/check-dead-exports.sh` only walks `packages/*/src` for both findings and references. `packages/desktop/renderer-next/` lives outside that scan root, so its imports do not count; the existing allowlist already carries the same carve-out for other renderer-next consumers.

**Rule:** When a new `src/shell/*.ts` module is consumed only by `renderer-next` or `test/`, add its exported names to `scripts/dead-exports-allow.txt` under the "Consumed from packages/desktop/renderer-next/src" section in the same commit, then run `bash scripts/check-dead-exports.sh` before pushing.
