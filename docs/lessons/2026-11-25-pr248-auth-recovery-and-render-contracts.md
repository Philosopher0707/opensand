# PR #248: auth fallback needs the engine's real error, and render tests must drive the form

**Trap:** The first OpenCode auth probe printed `provider authentication required` to stderr and exited. The bridge reported "is not signed in" and reset the engine to OpenSand, so the probe looked green while the production ACP path (`session/prompt` JSON-RPC error) left `opencode` selected.
**Root Cause:** The fake used a different transport from production, and the fallback decided from one rendered English phrase (`/is not signed in/i`). OpenCode's `explainError` branch renders "has no working sign-in" instead.
**Rule:** Inject failures through the engine's real transport and assert the persisted state. One shared, engine-agnostic auth predicate (`isAuthFailure` in `packages/coordinator/src/errors.ts`) decides the fallback, so any engine's sign-in wording is covered. Regression: `packages/desktop/test/engine-selection.test.ts` uses a `session/prompt` JSON-RPC error from the fake `opencode acp`.

**Trap:** The first ACP fixture error had no `(model fake/model-a)` suffix, so the new test asserted a model the rendered message did not contain.
**Root Cause:** The wrapper appends the model only when it can resolve the session's model; the recorded production message carries the suffix in the JSON-RPC error itself.
**Rule:** Copy the recorded error's full text into the fixture, not just its headline. Prove the assertion red→green before trusting it.

**Trap:** The new real-window navigation used `window.location.hash = ...` directly; `scripts/check-real-window-nav.sh` failed the full verify gate.
**Root Cause:** A one-shot hash change can be lost when the view's `hashchange` subscriber mounts a tick later; a helper with bounded retry already exists.
**Rule:** Real-window runners navigate only through `navigateToView({ js, sleep }, hash, selector)` from `packages/desktop/test/helpers/navigate-view.ts` (a repeat of the 2026-11-23 lesson, caught by the existing automatic check).

**Trap:** `scripts/check-dead-exports.sh` scanned `packages/*/src` only, so three live helpers imported from `packages/desktop/renderer-next/src/views/SettingsView.tsx` were reported dead and CI failed on Linux and macOS.
**Root Cause:** The second front-end tree was never parsed as a referencing consumer; allowlisting the exports would have hidden the checker's blind spot.
**Rule:** Scan `renderer-next/src` as a reference-only root (imports count, its own exports are not findings) and keep the selftest fixture that imports an export only from there.
