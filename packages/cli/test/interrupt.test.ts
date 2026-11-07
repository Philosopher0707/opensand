import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldExitOnSigInt, DOUBLE_SIGINT_WINDOW_MS } from "../src/interrupt.js";

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
