import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/system-prompt.js";

describe("SystemPrompt", () => {
  it("builds a complete system prompt with default environment", () => {
    const prompt = buildSystemPrompt();

    assert.match(prompt, /You are OpenSand/);
    assert.match(prompt, /## Environment & Context/);
    assert.match(prompt, /## Core Operating Principles/);
    assert.match(prompt, /Ground Before Action/);
    assert.match(prompt, /## Tools Available/);
  });

  it("incorporates custom workspace and user instructions", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/my/custom/project",
      userInstructions: "Always write TypeScript in strict mode.",
    });

    assert.match(prompt, /Workspace directory: \/my\/custom\/project/);
    assert.match(prompt, /Always write TypeScript in strict mode\./);
  });
});
