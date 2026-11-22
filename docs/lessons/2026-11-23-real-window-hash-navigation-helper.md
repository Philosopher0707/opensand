# A one-shot hash fix in one test leaves the same race in every other real-window test

**Trap:** Skills was hardened with a bounded hash-change re-dispatch, but routines, vault, rooms and navigation still set `window.location.hash` once and then waited for the view to become visible. The fix existed only in the file where the flake was seen, so the same lost-event race could reappear anywhere and a direct assignment could be reintroduced into skills at any time.

**Root Cause:** A race fix was left as inline test code instead of a shared helper, and no check enforced the navigation contract. A DOM node can exist before Preact's `hashchange` subscriber mounts, so one assignment plus one synthetic event can be lost; a plain `wait` then times out with no diagnostic.

**Rule:** When a race fix proves necessary in one real-window runner, extract it into one helper (here, `packages/desktop/test/helpers/navigate-view.ts`, `navigateToView({ js, sleep }, hash, selector, timeoutMs)`) and switch every runner that navigates by hash to it. Add a repo check that fails on a direct `location.hash` assignment in any `*-real-window.test.ts` and wire it into verify.sh, so reintroduction is caught before CI. Reads of `location.hash` in measurement snapshots are not assignments. [checked: scripts/check-real-window-nav.sh]
