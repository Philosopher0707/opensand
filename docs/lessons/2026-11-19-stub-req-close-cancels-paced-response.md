# A test stub that clears response timers on req "close" never answers at all

- **Trap:** The chat real-window test's OpenAI-compatible stub paced its SSE chunks with
  timers and cleared them in a `req.on("close")` guard. The engine sent the request, the
  stub received it, and then nothing ever came back: the turn stayed in its approval-wait
  state forever and the test failed with "turn never finished".
- **Root Cause:** Node's `IncomingMessage` fires `close` as soon as the request body has
  been read — long before the response is written. The guard therefore cancelled the
  paced chunks before the first one was sent, and the engine waited on a response that
  was never written. The same guard was correct on the slow-model path only because its
  first chunk is written synchronously.
- **Rule:** Only disconnect guards belong on the RESPONSE side (`res.on("close")` /
  `req.on("close")` checked against a "response finished" flag). A stub must never tie
  pending response timers to request-stream close. Add one logged line per stub request
  while debugging streaming tests — it separates "request never arrived" from "response
  never written" in one run.
