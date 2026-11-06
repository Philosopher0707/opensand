import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolArgs,
  summarizeToolCall,
  summarizeToolResult,
  previewToolOutput,
  formatDuration,
} from "../src/tool-summary.js";

describe("parseToolArgs", () => {
  it("parses a JSON object", () => {
    assert.deepEqual(parseToolArgs('{"path":"a.ts"}'), { path: "a.ts" });
  });

  it("returns {} for invalid JSON or non-objects", () => {
    assert.deepEqual(parseToolArgs("not json{"), {});
    assert.deepEqual(parseToolArgs("[1,2]"), {});
    assert.deepEqual(parseToolArgs(""), {});
  });
});

describe("summarizeToolCall", () => {
  it("summarizes exec_command with cwd", () => {
    const s = summarizeToolCall("exec_command", {
      command: "git status && ls -la",
      cwd: "/Users/philosopher/dev/opensand/.worktrees/cli-p0",
    });
    assert.match(s, /^run: git status/);
    assert.match(s, /cli-p0\)?$/);
  });

  it("humanizes file reads and writes", () => {
    assert.equal(
      summarizeToolCall("read_file", { path: "packages/cli/src/cli-app.ts" }),
      "read packages/cli/src/cli-app.ts"
    );
    assert.match(
      summarizeToolCall("read_file", { path: "a.ts", start_line: 1, end_line: 40 }),
      /lines 1–40/
    );
    assert.match(
      summarizeToolCall("write_file", { path: "x.txt", content: "hi" }),
      /^write x\.txt/
    );
  });

  it("covers common orchestrator tools", () => {
    assert.match(summarizeToolCall("web_search", { query: "node 22" }), /search web/);
    assert.match(summarizeToolCall("git_status", {}), /git status/);
    assert.match(summarizeToolCall("create_agent", { name: "cto" }), /create agent "cto"/);
    assert.match(summarizeToolCall("list_agents", {}), /list agents/);
  });

  it("falls back gracefully for unknown tools", () => {
    assert.equal(summarizeToolCall("some_new_tool", {}), "some_new_tool");
    assert.match(summarizeToolCall("some_new_tool", { title: "hello" }), /some_new_tool — hello/);
  });
});

describe("formatDuration", () => {
  it("formats sub-second, seconds, and minutes", () => {
    assert.equal(formatDuration(250), "250ms");
    assert.equal(formatDuration(1200), "1.2s");
    assert.equal(formatDuration(65_000), "1m 5s");
    assert.equal(formatDuration(NaN), "");
  });
});

describe("summarizeToolResult / previewToolOutput", () => {
  it("summarizes ok results with duration and output hints", () => {
    const s = summarizeToolResult(
      "read_file",
      { status: "ok", output: { totalLines: 42, bytes: 1500 } },
      Date.now()
    );
    assert.match(s, /ok/);
    assert.match(s, /42 lines/);
  });

  it("summarizes errors and pending", () => {
    assert.match(
      summarizeToolResult("exec_command", { status: "error", error: { message: "boom" } }),
      /error: boom/
    );
    assert.match(
      summarizeToolResult("exec_command", { status: "permission_pending" }),
      /awaiting approval/
    );
  });

  it("previews stdout lines with a truncation note", () => {
    const previews = previewToolOutput("exec_command", {
      stdout: "line1\nline2\nline3\nline4\nline5",
      stderr: "",
    });
    assert.equal(previews.length, 4); // 3 lines + truncation note
    assert.match(previews[3]!, /more lines/);
    assert.deepEqual(previewToolOutput("exec_command", { stdout: "" }), []);
  });
});
