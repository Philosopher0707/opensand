# Preact effect subscription can race a real-window test trigger

**Trap:** The auth-modal real-window test waited for `#authModal` to exist, dispatched `opensand:auth_required`, and timed out: the component registered `data.onAuthRequired` in a `useEffect` that runs after the node is painted, so the first event was missed.

**Root Cause:** DOM presence proves render, not that effects have subscribed; a one-shot synthetic event dispatched between those two points has no listener.

**Rule:** In Electron/Preact tests, trigger an event through a bounded retry loop rather than dispatching once immediately after the target node appears, and wait on a settled-state marker before acting on the new UI (not just a fixed sleep). `auth-modal-real-window.test.ts` retries `opensand:auth_required` up to 20 times, then waits for the input's focus effect and two frames before clicking. A one-off rerun that failed at the empty-submit step was fixed by that readiness wait, not by re-running the test.
