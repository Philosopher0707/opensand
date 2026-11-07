import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchSession } from "../src/sessions.js";

const sessions = [
  { sessionId: "session_aaa", mtimeMs: 300, turns: 2 },
  { sessionId: "session_bbb", mtimeMs: 200, turns: 1 },
  { sessionId: "other_ccc", mtimeMs: 100, turns: 5 },
];

describe("matchSession", () => {
  it("resolves latest to the newest session", () => {
    assert.equal(matchSession(sessions, "latest").session?.sessionId, "session_aaa");
  });

  it("resolves an exact id", () => {
    assert.equal(matchSession(sessions, "other_ccc").session?.sessionId, "other_ccc");
  });

  it("resolves a unique prefix", () => {
    assert.equal(matchSession(sessions, "other").session?.sessionId, "other_ccc");
  });

  it("reports ambiguity instead of silently picking one", () => {
    const match = matchSession(sessions, "session_");
    assert.equal(match.session, undefined);
    assert.deepEqual(match.ambiguous?.map((s) => s.sessionId), ["session_aaa", "session_bbb"]);
  });

  it("returns nothing for an unknown id", () => {
    assert.deepEqual(matchSession(sessions, "zzz"), {});
  });
});
