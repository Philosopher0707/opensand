# 429 needs patience and a visible wait, not a fast failure

**Trap:** An OpenRouter `:free` model returned 429 and the desktop showed the raw error after ~3.5s. A retry callback (`onRetry`) existed in the coordinator config but no caller anywhere set it, so the user never saw a wait happen.

**Root Cause:** 429 shared the generic 3-retry policy (0.5s + 1s + 2s), which cannot clear a free-model per-minute limit. `Retry-After` was capped at 30s, `X-RateLimit-Reset` was ignored, and a daily-quota reset hours away was treated like a short wait. The only notification hook had no production caller.

**Rule:** Give 429 its own bounded budget (6 waits: 2/5/10/20/30/30s, ~2 min wall time) separate from 5xx; honour `Retry-After` and `X-RateLimit-Reset`, and fail at once with the reset time and a "switch model" suggestion when the reset lies beyond the budget. Wire one `onRetry` event through the desktop bridge (renderer live countdown) and the CLI (ticking status), clear the wait on stop/end, and keep `maxRetries: 0` meaning no retries. Regression: `packages/coordinator/test/rate-limit-retry.test.ts`, `packages/desktop/test/chat-turn-model.test.ts`.
