# Chat send queue: keep follow-ups at shell level and never surface a raw send error

**Trap:** Phase 5 inventory row 2 (chat send queue) had no shell equivalent. In the Preact
renderer, typing while a turn ran did nothing — Send was disabled — and a rejected
`sendQuery` put `err.message` straight into the chat status line (the path was even
allowlisted in `scripts/raw-errors-allow.txt`). The legacy renderer queues follow-ups in a
module-level array, shows a count, lets you cancel one, drains on `turn_complete`, and drops
the queue on error or cancel.

**Root Cause:** The chat turn state machine was ported without its queue, and the composer
treated "busy" as a hard block instead of a queue signal. Queue state also has to outlive
the Chat component's local state, because view switches keep the shell mounted.

**Rule:** Keep the queue in a pure `src/shell/chat-send-queue.ts` model and hold that state in
`useChatTurn` at the shell level: enqueue on send-while-busy, cancel by stable id, drain FIFO
only on a busy→done transition, and clear it on failed/stopped (matching legacy). Format a
failed send through `friendlyErrorMessage` with a fixed fallback, then delete the stale raw
error allowlist row so the gate proves the fix. Cover empty/cancel/plain-error/FIFO with
model unit tests and the visible queue + view-switch survival with a real-window harness test
at 960×740 and 1920×1080. Read row specs from the refreshed base's inventory, not a stale
local checkout, and relink the cached same-version Electron `dist`/`path.txt` into a fresh
worktree before any real-window test.
