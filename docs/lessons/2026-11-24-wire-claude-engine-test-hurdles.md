# Wiring the Claude Code engine selector: two test hurdles (2026-11-24)

## A turn completes twice, so "first completion" is the wrong synchronization

- **Trap:** A new desktop-server test captured the reply from the first `turn_complete` event after
  each query. It passed alone but failed in the full suite, asserting turn 1's reply for turn 2.
- **Root Cause:** `DesktopIpcBridge` emits `turn_complete` twice per turn: once from `dispatchTurnEvent`
  when the coordinator emits `turn_completed`, and again from `sendQuery()`'s promise resolution.
  Under load, turn 1's second event arrives after turn 2 has started and overwrites the captured value.
- **Rule:** When two layers emit the same completion event, wait for the expected payload (response
  text or turn id), not merely for the first event of that type. Applied in
  `packages/desktop/test/engine-selection.test.ts`.

## A real-window timeout under parallel load is not a regression until the file passes alone

- **Trap:** The full suite failed because `restore-real-window.test.js` took 120.0s against the
  120s per-file ceiling, even though the test itself passed at 118.3s.
- **Root Cause:** Other package suites and real-window files were competing for the same host; running the
  file alone took 96.8s and passed.
- **Rule:** Classify a parallel-suite real-window timeout only after running that file alone; keep
  `OPENSAND_SKIP_REAL_WINDOW=1` for local iterations and reserve real-window runs for the PR gate.
