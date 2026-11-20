import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Write an executable, self-contained Node fake CLI. Logs go to env-named files. */
export async function writeFakeCli(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

export async function readJsonl(path: string | undefined): Promise<unknown[]> {
  if (!path) return [];
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Fake Claude Code: retained stdin, stream-json events, one result per prompt. */
export const FAKE_CLAUDE = `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.ARGV_LOG) fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (process.env.MSG_LOG) fs.appendFileSync(process.env.MSG_LOG, JSON.stringify(msg) + "\\n");
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    out({ type: "system", subtype: "init", session_id: "sess-1" });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });
    out({ type: "result", is_error: false, result: "hello" });
  }
});
`;

/** Fake Codex app-server: initialize → initialized → thread/start → turn/start. */
export const FAKE_CODEX = `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.ARGV_LOG) fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (process.env.MSG_LOG) fs.appendFileSync(process.env.MSG_LOG, JSON.stringify(msg) + "\\n");
    if (!msg.method) continue;
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex" } });
    else if (msg.method === "thread/start") send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-1" } } });
    else if (msg.method === "turn/start") {
      send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn-1" } } });
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "hello" } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
    }
  }
});
`;

/** Fake ACP server: initialize → session/new → session/prompt, with a text chunk. */
export const FAKE_ACP = `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.ARGV_LOG) fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (process.env.MSG_LOG) fs.appendFileSync(process.env.MSG_LOG, JSON.stringify(msg) + "\\n");
    if (!msg.method) continue;
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    else if (msg.method === "session/new" || msg.method === "session/load") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1", configOptions: [{ id: "mode", currentValue: "default" }, { id: "model", currentValue: "auto" }] } });
    } else if (msg.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [{ id: msg.params.configId, currentValue: msg.params.value }] } });
    } else if (msg.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } } });
    }
  }
});
`;

/** ACP fake that advertises a dynamic model catalog in session/new. */
export const FAKE_ACP_MODELS = FAKE_ACP.replace(
  'configOptions: [{ id: "mode", currentValue: "default" }, { id: "model", currentValue: "auto" }]',
  'configOptions: [{ id: "mode", currentValue: "default" }, { id: "model", currentValue: "probed/model-2", options: [{ value: "probed/model-1", name: "Model One" }, { value: "probed/model-2", name: "Model Two" }] }]'
);

/** Codex app-server fake that serves a paged model/list catalog. */
export const FAKE_CODEX_MODELS = FAKE_CODEX.replace(
  'if (msg.method === "initialize")',
  'if (msg.method === "model/list") send({ jsonrpc: "2.0", id: msg.id, result: { data: [{ id: "probed-o3", displayName: "Probed o3", isDefault: true }, { id: "probed-mini", displayName: "Probed Mini" }] } });\n    else if (msg.method === "initialize")'
);

/** Claude CLI fake that emits a tool_use block before the result. */
export const FAKE_CLAUDE_TOOLS = FAKE_CLAUDE.replace(
  'out({ type: "result", is_error: false, result: "hello" });',
  'out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-1", name: "read_file" }] } });\n    out({ type: "result", is_error: false, result: "hello" });'
);

/** ACP fake that emits a tool_call update before completing the turn. */
export const FAKE_ACP_TOOLS = FAKE_ACP.replace(
  'send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } } });',
  'send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read_file", status: "completed" } } });\n      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } } });'
);

/** Codex fake that emits item/started + item/completed for a tool. */
export const FAKE_CODEX_TOOLS = FAKE_CODEX.replace(
  'send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });',
  'send({ jsonrpc: "2.0", method: "item/started", params: { item: { type: "commandExecution", id: "it-1", command: "pwd" } } });\n      send({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "commandExecution", id: "it-1" } } });\n      send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });'
);
