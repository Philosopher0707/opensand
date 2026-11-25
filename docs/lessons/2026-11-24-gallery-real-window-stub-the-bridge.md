# Gallery real-window test must stub the bridge, not a private hook

- **Trap:** Rigel reported `gallery-real-window.test.ts` rendering the 8 live server templates instead
  of the 2 stubbed cards, even though `renderer-next/src/data/gallery.ts` already checked
  `window.__testGalleryTemplates`. A local run passed and CI was green, so the reported failure
  could not be reproduced from the assertion alone.
- **Root Cause:** The test relied on a private `__testGalleryTemplates` hook. The app builds
  `windowBridgeData()` at module load with `b = window.opensand`, and `galleryData` falls through to
  HTTP whenever the hook is missing (stale bundle or a differently shaped data layer). The other
  real-window tests stub the bridge object itself (`window.opensand.getAgents`, `window.opensand.createPolicy`),
  which `windowBridgeData` reads on every call.
- **Rule:** In real-window tests stub the `window.opensand` bridge method the production data layer
  calls, not a private hook a bundle can drop. Keep the assertion at the real card titles and add a
  model-level case that sets the stub and proves no network call is made. Renderer-next sources are
  Vite-bundled and not emitted to `dist`, so a model test loads the `.ts` source with a dynamic import
  (Node 22.18+/26 strip types). Rebase before pushing: the four shared files (data.ts, shell.css,
  registry.ts, dead-exports-allow.txt) conflict with other Phase 5 rows; resolve append-only.
