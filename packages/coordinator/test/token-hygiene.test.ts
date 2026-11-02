import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  truncateToolOutput,
  foldHistoricalToolResults,
  selectActiveTools,
  CORE_TOOL_NAMES,
} from "../src/token-hygiene.js";
import { ChatMessage } from "../src/types.js";
import { ToolDefinition } from "@opensand/local-exec-daemon";

describe("Token Efficiency & Hygiene System", () => {
  it("leaves short tool outputs untouched", () => {
    const shortText = "Command executed successfully. Exit code: 0";
    const result = truncateToolOutput(shortText, { maxCharacters: 1000 });
    assert.strictEqual(result, shortText);
  });

  it("truncates massive tool outputs with head/tail preservation", () => {
    const headPart = "START_OF_OUTPUT: line 1\nline 2\n";
    const middlePart = "x".repeat(50000);
    const tailPart = "\nEND_OF_OUTPUT: exit code 0";
    const hugeText = headPart + middlePart + tailPart;

    const truncated = truncateToolOutput(hugeText, {
      maxCharacters: 1000,
      headCharacters: 200,
      tailCharacters: 100,
    });

    assert.ok(truncated.length < 1000);
    assert.ok(truncated.startsWith(headPart.slice(0, 50)));
    assert.ok(truncated.endsWith(tailPart));
    assert.ok(truncated.includes("[... Tool output truncated:"));
    assert.ok(truncated.includes("characters omitted for token efficiency"));
  });

  it("folds historical tool results from older turns into compact summaries", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are OpenSand." },
      // Turn 1 (Old turn)
      { role: "user", content: "Check the filesystem." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify({ status: "ok", output: { path: "large-file.ts", content: "y".repeat(15000) } }),
      },
      { role: "assistant", content: "File read successfully." },
      // Turn 2 (Old turn)
      { role: "user", content: "Run the build." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_2", type: "function", function: { name: "exec_command", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: JSON.stringify({ status: "ok", output: { exitCode: 0, stdout: "build log ".repeat(2000) } }),
      },
      { role: "assistant", content: "Build passed." },
      // Turn 3 (Recent turn 1)
      { role: "user", content: "Inspect git status." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_3", type: "function", function: { name: "git_status", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call_3",
        content: JSON.stringify({ status: "ok", output: { branch: "main", clean: true } }),
      },
      { role: "assistant", content: "Branch is clean." },
      // Turn 4 (Recent turn 2 - current)
      { role: "user", content: "What is next?" },
    ];

    // Keep recent 2 turns: Turn 3 and Turn 4 are kept. Turn 1 and Turn 2 tool results should be folded!
    const folded = foldHistoricalToolResults(messages, 2, 200);

    // Turn 1 tool result should now be a short summary
    const turn1Tool = folded.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
    assert.ok(turn1Tool);
    assert.ok(turn1Tool.content && turn1Tool.content.length < 200);
    assert.ok(turn1Tool.content && turn1Tool.content.includes("Past tool output folded"));
    assert.ok(turn1Tool.content && turn1Tool.content.includes("read_file"));

    // Turn 2 tool result should also be folded
    const turn2Tool = folded.find((m) => m.role === "tool" && m.tool_call_id === "call_2");
    assert.ok(turn2Tool);
    assert.ok(turn2Tool.content && turn2Tool.content.length < 200);
    assert.ok(turn2Tool.content && turn2Tool.content.includes("exec_command exited with code 0"));

    // Turn 3 tool result is in the recent 2 turns, so it should NOT be folded
    const turn3Tool = folded.find((m) => m.role === "tool" && m.tool_call_id === "call_3");
    assert.ok(turn3Tool);
    assert.ok(turn3Tool.content && turn3Tool.content.includes("branch"));
  });

  it("selectActiveTools adaptively scopes tool definitions", () => {
    const emptyParams = { type: "object" as const, properties: {} };
    const mockTools: ToolDefinition[] = [
      { type: "function", function: { name: "exec_command", description: "exec", parameters: emptyParams } },
      { type: "function", function: { name: "read_file", description: "read", parameters: emptyParams } },
      { type: "function", function: { name: "write_file", description: "write", parameters: emptyParams } },
      { type: "function", function: { name: "vault_store_secret", description: "vault", parameters: emptyParams } },
      { type: "function", function: { name: "create_routine", description: "routine", parameters: emptyParams } },
      { type: "function", function: { name: "create_room", description: "room", parameters: emptyParams } },
      { type: "function", function: { name: "recognize_screen_text", description: "ocr", parameters: emptyParams } },
    ];

    // Default 'auto' on a standard coding prompt returns only core tools
    const codingTools = selectActiveTools(mockTools, "Refactor the file-ops module", "auto");
    assert.strictEqual(codingTools.length, 3);
    assert.ok(codingTools.every((t) => CORE_TOOL_NAMES.has(t.function.name)));

    // When query mentions vault, vault tools are dynamically activated
    const vaultTools = selectActiveTools(mockTools, "Store the API key in the vault secret store", "auto");
    assert.ok(vaultTools.some((t) => t.function.name === "vault_store_secret"));
    assert.ok(vaultTools.some((t) => t.function.name === "exec_command"));
    assert.ok(!vaultTools.some((t) => t.function.name === "create_routine"));

    // When mode is 'all', all tools are returned
    const allTools = selectActiveTools(mockTools, "any prompt", "all");
    assert.strictEqual(allTools.length, mockTools.length);
  });
});
