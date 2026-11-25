# A new `src/shell` model consumed only by `renderer-next` trips the dead-export gate

- **Trap:** CI failed both build jobs with `FAIL: 5 NEW dead export(s)` for `ocr-model.ts`, although `QuickOcr.tsx` imports all five symbols. Local type-check and tests were green.
- **Root Cause:** `scripts/check-dead-exports.sh` walks `packages/*/src` only, so imports from `packages/desktop/renderer-next/src` (and from tests) do not count as references. `quick-capture-model.ts` is already allowlisted for the same reason.
- **Rule:** When a new export in `packages/*/src` is used only by renderer-next or tests, add its `path|kind name` key to `scripts/dead-exports-allow.txt` in the same PR and run the gate locally before pushing.
