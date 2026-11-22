import test from "node:test";
import assert from "node:assert";
import {
  computeTelemetryPct,
  getTelemetryMeterColor,
  formatMemoryText,
  resolvePersona,
  resolveAvatarIcon,
  DEFAULT_PERSONA,
  DEFAULT_TELEMETRY,
  DEFAULT_SKILLS,
  type AgentPersona,
} from "../src/shell/inspector-model.js";

test("InspectorModel - computeTelemetryPct", () => {
  assert.strictEqual(computeTelemetryPct(0, 1000), 0);
  assert.strictEqual(computeTelemetryPct(500, 1000), 50);
  assert.strictEqual(computeTelemetryPct(100, 0), 0);
  assert.strictEqual(computeTelemetryPct(-10, 1000), 0);
  assert.strictEqual(computeTelemetryPct(1500, 1000), 100);
  assert.strictEqual(computeTelemetryPct(1234, 10000), 12.3);
});

test("InspectorModel - getTelemetryMeterColor", () => {
  assert.strictEqual(getTelemetryMeterColor(30), "var(--accent-gradient, linear-gradient(135deg, #3b82f6, #8b5cf6))");
  assert.strictEqual(getTelemetryMeterColor(50), "var(--accent-gradient, linear-gradient(135deg, #3b82f6, #8b5cf6))");
  assert.strictEqual(getTelemetryMeterColor(51), "var(--warning, #d97706)");
  assert.strictEqual(getTelemetryMeterColor(80), "var(--warning, #d97706)");
  assert.strictEqual(getTelemetryMeterColor(81), "var(--danger, #dc2626)");
  assert.strictEqual(getTelemetryMeterColor(100), "var(--danger, #dc2626)");
});

test("InspectorModel - formatMemoryText", () => {
  assert.strictEqual(formatMemoryText("raw memory note"), "raw memory note");
  assert.strictEqual(formatMemoryText({ content: "user prefers TypeScript" }), "user prefers TypeScript");
  assert.strictEqual(formatMemoryText({ fact: "project uses pnpm workspaces" }), "project uses pnpm workspaces");
  assert.strictEqual(formatMemoryText({ rule: "never skip tests" }), "never skip tests");
  assert.strictEqual(formatMemoryText({ other: 42 }), JSON.stringify({ other: 42 }));
  assert.strictEqual(formatMemoryText("" as any), "");
});

test("InspectorModel - resolvePersona", () => {
  const agents: AgentPersona[] = [
    { id: "agent-1", name: "Pixel", role: "Frontend Specialist", model: "claude-3-7-sonnet" },
    { id: "agent-2", name: "Gump", role: "Chief of Staff", model: "gpt-4o", kind: "ROOM" },
  ];

  assert.strictEqual(resolvePersona(agents, "agent-1").name, "Pixel");
  assert.strictEqual(resolvePersona(agents, "agent-2").role, "Chief of Staff");
  assert.strictEqual(resolvePersona(agents, "unknown-agent"), DEFAULT_PERSONA);
  assert.strictEqual(resolvePersona([], "agent-1"), DEFAULT_PERSONA);
  assert.strictEqual(resolvePersona(null, "agent-1"), DEFAULT_PERSONA);
  assert.strictEqual(resolvePersona(agents, null), DEFAULT_PERSONA);
});

test("InspectorModel - resolveAvatarIcon", () => {
  assert.strictEqual(resolveAvatarIcon({ id: "1", name: "Room", kind: "ROOM" }), "👥");
  assert.strictEqual(resolveAvatarIcon({ id: "2", name: "Spec", kind: "SPECIALIST" }), "✨");
  assert.strictEqual(resolveAvatarIcon({ id: "3", name: "Bot" }), "🤖");
});

test("InspectorModel - defaults export validity", () => {
  assert.ok(DEFAULT_PERSONA.name);
  assert.ok(DEFAULT_PERSONA.model);
  assert.strictEqual(DEFAULT_TELEMETRY.estimatedTokens, 0);
  assert.strictEqual(DEFAULT_TELEMETRY.maxContextTokens, 1048576);
  assert.strictEqual(DEFAULT_SKILLS.length, 3);
});
