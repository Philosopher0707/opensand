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

  it("instructs the model to narrate tool use for human audiences", () => {
    const prompt = buildSystemPrompt();

    assert.match(prompt, /## Communicating Progress/);
    assert.match(prompt, /Before you call any tool/);
    assert.match(prompt, /one short, plain sentence/);
    assert.match(prompt, /what you are\s+about to do and why/);
  });

  it("buildSystemPrompt gives an agent an authoritative identity", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/tmp/ws",
      agentName: "Security Sentinel",
      agentRole: "Security reviewer",
      userInstructions: "Always cite the exact file and line.",
    });
    assert.match(prompt, /^You are Security Sentinel — Security reviewer, a specialist bot operating inside OpenSand\./);
    assert.match(prompt, /## Persona Boundary/);
    assert.match(prompt, /## User Custom Instructions/);
    assert.doesNotMatch(prompt.split("\n")[0], /You are OpenSand/);
  });

  it("adds a delegation protocol only for the chief", () => {
    const chief = buildSystemPrompt({ agentName: "CTO Bot", agentRole: "Chief of Staff", chiefInstructions: "Delegate specialist work via delegate_to_agent." });
    const plain = buildSystemPrompt({ agentName: "Coder", agentRole: "Engineer" });
    assert.match(chief, /## Delegation Protocol/);
    assert.match(chief, /Delegate specialist work via delegate_to_agent\./);
    assert.doesNotMatch(plain, /## Delegation Protocol/);
    assert.match(plain, /You are Coder — Engineer/);
  });
});
