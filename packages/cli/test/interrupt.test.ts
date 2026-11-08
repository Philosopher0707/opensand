import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldExitOnSigInt, sigIntAction, DOUBLE_SIGINT_WINDOW_MS, formatResumeHint } from "../src/interrupt.js";

describe("Interrupt / SIGINT exit logic", () => {
  it("returns true when now is within window of lastAt", () => {
    const now = 2000;
    const lastAt = 1000; // 1000ms difference <= 1500ms
    assert.equal(shouldExitOnSigInt(lastAt, now), true);
  });

  it("returns false when lastAt is 0", () => {
    const now = 2000;
    assert.equal(shouldExitOnSigInt(0, now), false);
  });

  it("returns false when now is outside the window", () => {
    const lastAt = 1000;
    const now = 3000; // 2000ms difference > 1500ms
    assert.equal(shouldExitOnSigInt(lastAt, now), false);
  });
});

describe("sigIntAction", () => {
  it("cancels the running turn first, regardless of the exit window", () => {
    assert.equal(sigIntAction(true, 1000, 1200), "cancel");
    assert.equal(sigIntAction(true, 0, 1200), "cancel");
  });

  it("exits on a second press inside the window, arms on the first", () => {
    assert.equal(sigIntAction(false, 1000, 1200), "exit");
    assert.equal(sigIntAction(false, 0, 1200), "arm");
    assert.equal(sigIntAction(false, 1000, 3000), "arm");
  });
});

describe("formatResumeHint", () => {
  it("formats resume hint with the session id", () => {
    const sessionId = "session-test-uuid-123";
    assert.equal(
      formatResumeHint(sessionId),
      "To resume this session, run:\n  opensand --resume session-test-uuid-123"
    );
  });
});
