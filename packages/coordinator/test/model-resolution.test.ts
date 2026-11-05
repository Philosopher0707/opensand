import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentModel } from "../src/model-resolution.js";

describe("agent model resolution", () => {
  it('maps the historical "default" sentinel to the ambient model', () => {
    assert.equal(resolveAgentModel("default", "crouton-alpha"), "crouton-alpha");
    assert.equal(resolveAgentModel(" default ", "crouton-alpha"), "crouton-alpha");
    assert.equal(resolveAgentModel(null, "crouton-alpha"), "crouton-alpha");
    assert.equal(resolveAgentModel("", "crouton-alpha"), "crouton-alpha");
  });

  it("preserves an explicit agent model", () => {
    assert.equal(resolveAgentModel("agent-model", "crouton-alpha"), "agent-model");
  });

  it("never returns the sentinel when no ambient model is configured", () => {
    assert.equal(resolveAgentModel("default", "default"), "qwen3:8b");
    assert.equal(resolveAgentModel("default", null), "qwen3:8b");
  });
});
