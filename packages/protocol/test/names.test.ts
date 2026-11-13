import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EVENTS, METHODS, isKnownMethod, isWellFormedName } from "../src/names.js";

describe("protocol names", () => {
  it("registers the methods and events listed in the OSP spec", () => {
    assert.equal(METHODS.length, 22);
    assert.equal(EVENTS.length, 15);
  });

  it("uses unique, well-formed names throughout", () => {
    for (const name of [...METHODS, ...EVENTS]) {
      assert.ok(isWellFormedName(name), `${name} is not namespace.Class.name`);
    }
    assert.equal(new Set(METHODS).size, METHODS.length);
    assert.equal(new Set(EVENTS).size, EVENTS.length);
  });

  it("recognises registered methods and rejects unknown ones", () => {
    assert.equal(isKnownMethod("mission.Missions.start"), true);
    assert.equal(isKnownMethod("mission.Missions.nope"), false);
    assert.equal(isKnownMethod("mission.Missions.nodeStarted"), false);
  });

  it("rejects names that are not namespace.Class.member", () => {
    assert.equal(isWellFormedName("mission.start"), false);
    assert.equal(isWellFormedName("Mission.Missions.start"), false);
    assert.equal(isWellFormedName("mission.Missions.Start"), false);
    assert.equal(isWellFormedName(""), false);
  });
});
