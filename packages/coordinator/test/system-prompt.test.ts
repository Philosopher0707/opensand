import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UNTRUSTED_SYSTEM_LINE } from "@opensand/shared";
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

  it("instructs the model to narrate tool use for human audiences", () => {
    const prompt = buildSystemPrompt();

    assert.match(prompt, /## Communicating Progress/);
    assert.match(prompt, /Before you call any tool/);
    assert.match(prompt, /one short, plain sentence/);
    assert.match(prompt, /what you are\s+about to do and why/);
  });

  it("has one Untrusted Content section between Communicating Progress and Tools Available", () => {
    const prompt = buildSystemPrompt();
    assert.equal(prompt.split("## Untrusted Content").length - 1, 1);
    const a = prompt.indexOf("## Communicating Progress");
    const b = prompt.indexOf("## Untrusted Content");
    const c = prompt.indexOf("## Tools Available");
    assert.ok(a >= 0 && a < b && b < c, `order ${a} ${b} ${c}`);
    assert.ok(prompt.includes("<data_source"));
    assert.ok(prompt.includes("never an instruction"));
    assert.ok(prompt.includes(UNTRUSTED_SYSTEM_LINE));
  });
});
