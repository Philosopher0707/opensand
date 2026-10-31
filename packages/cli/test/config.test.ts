import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/config.js";

describe("CliConfig", () => {
  it("parses custom flags and positional queries", () => {
    const args = [
      "--model",
      "llama3",
      "--endpoint",
      "http://localhost:11434/v1",
      "--api-key",
      "sk-test-123",
      "--auto-approve",
      "inspect",
      "workspace",
    ];

    const config = parseCliArgs(args);

    assert.equal(config.model, "llama3");
    assert.equal(config.endpoint, "http://localhost:11434/v1");
    assert.equal(config.apiKey, "sk-test-123");
    assert.equal(config.autoApprove, true);
    assert.equal(config.query, "inspect workspace");
  });

  it("handles -y shorthand for auto-approval", () => {
    const config = parseCliArgs(["-y", "git", "status"]);

    assert.equal(config.autoApprove, true);
    assert.equal(config.query, "git status");
  });

  it("defaults to standard environment", () => {
    const config = parseCliArgs([]);

    assert.ok(config.endpoint);
    assert.ok(config.model);
    assert.equal(config.autoApprove, false);
    assert.equal(config.query, undefined);
  });
});
