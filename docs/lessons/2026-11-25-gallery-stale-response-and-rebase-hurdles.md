# Gallery real-window flake was a stale-response race; two rebase/build hurdles

- **Trap:** `gallery-real-window.test.ts` failed on macOS CI with 8 live card titles where 2 stubbed
  titles were expected; a Linux run "passed" only because it skips real-window tests. Local runs
  failed intermittently (first a 25 s wait timeout, then the same 8-vs-2 assertion), so the earlier
  bridge-stub fix was necessary but not sufficient.
- **Root Cause:** the app starts `GalleryView.load()` on mount, before the test's `did-finish-load`
  handler can replace `window.opensand`. The test's Refresh starts a second load with the stub, but
  the first (live) request can resolve *later* and overwrite the stubbed cards — last response wins.
- **Fix:** `renderer-next/src/views/GalleryView.tsx` keeps a `loadSeq` ref; a response only updates
  state when its sequence is still current. Six consecutive real-window runs passed after the fix.
- **Rule:** any async view load must discard responses from superseded requests; in real-window
  tests, a pass on Linux proves nothing because those tests are skipped there.
- **Hurdle 2:** `git rebase --continue` appeared to hang after an INDEX.md conflict. Cause: no
  `GIT_EDITOR` is configured, so git opened vi and waited. Rule: run `GIT_EDITOR=true git rebase
  --continue` in scripts and agent flows.
- **Hurdle 3:** after rebasing onto a newer main, `tsc` reported many `Property 'engine' does not
  exist on DesktopSettings` errors inside `packages/desktop`. Cause: `packages/shared/dist` was
  stale; TypeScript resolves `@opensand/shared` through `dist/src/index.d.ts`. Rule: run the full
  `pnpm build` (dependency order) after rebase, never build a single package against old dist.
- **Hurdle 4:** `worktree.sh save` refused to run in an older scratch worktree. Cause: that worktree
  was linked from `~/dev/opensand`, so its git common dir is the protected owner checkout. Rule:
  create job worktrees from `~/dev/_scratch/opensand-base`; when an inherited worktree cannot use
  `save`, push from it with `git push --force-with-lease` after running the tests directly.
- **Hurdle 5:** CI failed at `verify.sh` on the lessons check. Cause: the lesson used `**Cause:**`
  instead of the required `**Root Cause:**`, and INDEX.md was hand-appended out of filename order.
  Rule: write `**Trap:**` / `**Root Cause:**` / `**Rule:**` lines and run
  `bash scripts/lessons-index.sh` rather than editing INDEX.md by hand.
  (OpenSand #243, 2026-11-25)
