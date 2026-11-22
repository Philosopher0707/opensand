# A broken Electron runner script hangs the real-window test silently

**Trap:** The new `rooms-real-window.test.ts` hung indefinitely with no output. The unit tests in
the same `node --test` call finished, but the real-window test printed nothing — not even its
own `[runner] timeout` message — and survived a 10-minute outer timeout.

**Root Cause:** The `RUNNER_SCRIPT` template literal had a missing opening quote on the final
fragment of a `js()` call (`})()");` instead of `"})()");`). Electron failed to parse the runner
("App threw an error during load / SyntaxError"), so no `BrowserWindow` was created, no
`close` event fired, and the test's buffered stdout/stderr was only ever printed after
`child.on("close")` — which never came. The failure looked like a slow/hung Electron launch.

**Rule:** A real-window test must fail fast when its runner cannot load: attach a `child.on("error")`
handler and a watchdog that kills the exact launched child and resolves a non-zero code after a
bounded wait, so the buffered output is surfaced by the existing assertion instead of hanging.
Also run `node --check` on an extracted runner when adding one. The rooms test now does both;
`shot()` also waits an extra settle frame after two rAFs so screenshots show settled state
rather than a transient "Loading rooms…" paint.
