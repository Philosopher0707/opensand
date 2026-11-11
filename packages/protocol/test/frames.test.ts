import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorCodes, OspError } from "../src/errors.js";
import { encodeLine, parseLine, type Frame } from "../src/frames.js";

function rejectionOf(line: string): OspError {
  try {
    parseLine(line);
  } catch (err) {
    assert.ok(err instanceof OspError, `expected OspError, got ${String(err)}`);
    return err;
  }
  assert.fail(`expected parseLine to reject: ${line}`);
}

describe("frame codec", () => {
  it("round-trips request, success, error and event frames", () => {
    const frames: Frame[] = [
      {
        id: "req-1",
        method: "mission.Missions.start",
        params: { workspaceRoot: "/tmp/p", title: "t", initialQuery: "q", budgetUsd: 2.5 },
      },
      { id: "req-1", result: { missionId: "m-1", status: "running" } },
      { id: "req-2", error: { code: ErrorCodes.StaleEpochError, message: "stale", data: { currentEpoch: 13 } } },
      {
        event: "mission.Missions.nodeCompleted",
        seq: 42,
        missionId: "m-1",
        ts: "2026-11-11T18:30:05.123Z",
        data: { node: "check", exitCode: 0, durationMs: 4210 },
      },
      { event: "engine.Engine.heartbeat", seq: 1, ts: "2026-11-11T18:30:00.000Z", data: { uptimeMs: 10 } },
    ];
    for (const frame of frames) {
      assert.deepEqual(parseLine(encodeLine(frame).trimEnd()), frame);
    }
  });

  it("encodes exactly one line terminated by a newline", () => {
    const line = encodeLine({ id: "r", method: "engine.Engine.ping", params: { note: "a\nb" } });
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
  });

  it("rejects malformed JSON with ParseError", () => {
    assert.equal(rejectionOf("{not json").code, ErrorCodes.ParseError);
  });

  it("rejects a request without an id with InvalidRequest", () => {
    const err = rejectionOf(JSON.stringify({ method: "engine.Engine.ping", params: {} }));
    assert.equal(err.code, ErrorCodes.InvalidRequest);
    assert.match(err.message, /id/);
  });

  it("rejects a request with a malformed method name", () => {
    const err = rejectionOf(JSON.stringify({ id: "r", method: "ping", params: {} }));
    assert.equal(err.code, ErrorCodes.InvalidRequest);
  });

  it("rejects a non-object frame", () => {
    assert.equal(rejectionOf("[1,2]").code, ErrorCodes.InvalidRequest);
    assert.equal(rejectionOf("null").code, ErrorCodes.InvalidRequest);
  });

  it("rejects an event whose seq is not a positive integer", () => {
    const base = { event: "engine.Engine.heartbeat", ts: "t", data: {} };
    assert.equal(rejectionOf(JSON.stringify({ ...base, seq: 0 })).code, ErrorCodes.InvalidRequest);
    assert.equal(rejectionOf(JSON.stringify({ ...base, seq: 1.5 })).code, ErrorCodes.InvalidRequest);
  });

  it("rejects an error response whose code is not an integer", () => {
    const err = rejectionOf(JSON.stringify({ id: "r", error: { code: "4001", message: "x" } }));
    assert.equal(err.code, ErrorCodes.InvalidRequest);
  });
});
