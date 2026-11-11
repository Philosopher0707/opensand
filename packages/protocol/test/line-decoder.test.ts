import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineDecoder } from "../src/line-decoder.js";

describe("LineDecoder", () => {
  it("reassembles a line split across chunks", () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push('{"id":"r1",'), []);
    assert.deepEqual(decoder.push('"method":"engine.Engine.ping"}\n{"id":"r2"'), ['{"id":"r1","method":"engine.Engine.ping"}']);
    assert.deepEqual(decoder.push(',"x":1}\n'), ['{"id":"r2","x":1}']);
  });

  it("strips CRLF endings and skips blank lines", () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push("a\r\n\n\r\nb\n"), ["a", "b"]);
  });

  it("returns an unterminated tail only from flush, then clears it", () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push("done\npartial"), ["done"]);
    assert.equal(decoder.flush(), "partial");
    assert.equal(decoder.flush(), null);
  });
});
