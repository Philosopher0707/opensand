# A pure model tested by Node must live in `src/shell`, not under `renderer-next`

- **Trap:** `ocr-model.test.ts` imported a pure classifier from `renderer-next/src/views/ocr-model.ts`. TypeScript compiled the test but emitted no JS for the model, so `node --test` failed with `ERR_MODULE_NOT_FOUND` at `dist/renderer-next/src/views/ocr-model.js`.
- **Root Cause:** `renderer-next` has its own `tsconfig.json` with `noEmit: true` and a bundler resolution mode; the desktop `tsc -b` project does not emit files from that directory. The existing `quick-capture-model.ts` already establishes where shared, testable logic belongs: `packages/desktop/src/shell/`.
- **Rule:** Put any pure logic that a desktop test imports under `packages/desktop/src/shell/` and import it with an explicit `.js` suffix. Keep JSX view components in `renderer-next/src/views/` and import the model from there.
