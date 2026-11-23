#!/usr/bin/env node
// agent_wrap: run one turn of another coding agent's own command-line program (Claude Code, Codex, GitHub Copilot CLI,
// Google Antigravity agy, OpenCode, WorkBuddy's CodeBuddy) from your app, headless. Its events come back normalised, and its permission
// questions are answered by your own approver. One file, no dependencies, Node >= 18.
//
//   node agent_wrap.mjs --detect
//   node agent_wrap.mjs [--engine claude] [--mode plan|agent] [--model M] [--resume ID] [--cwd DIR] [--timeout S] [--json] "prompt"
//
// The CLI has no approver, so in agent mode every question the engine asks is refused (fail closed). From code, pass
// approve({engine, tool, input, mode}) -> Promise<boolean> to runTurn. Rule numbers cited below are in
// coding-agent-engines/SKILL.md.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as facts from "./engine_facts.mjs";
import { ENGINE_FACTS, findBinary, findOnPath, defaultPathDirs, childEnv } from "./engine_facts.mjs";

const KILL_AFTER_MS = 3000; // SIGTERM, then SIGKILL this long after (rule 12)
const WRAP_UP_MS = 5000; // a turn's last line seen: the process may linger this long before SIGTERM (rule 12)
const DRAIN_MS = 1500; // after the process exits, how long its output may still arrive
const VERSION_MS = 5000; // the version lookup run before each turn; it never blocks a turn for longer
const STDERR_KEEP = 4096;
const MAX_LINE = 16 * 1024 * 1024;
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite"]); // Claude Code reads
const ACP_READ_KINDS = new Set(["read", "search", "think"]); // ACP tool kinds that only read
const WHERE_KEYS = new Set(["cwd", "workdir", "directory"]); // an OpenCode call that only says where it runs
const CHILD_CAPABILITY = "opencode/child-session-updates"; // ask OpenCode for sub-agent updates as their own messages
const CHILD_UPDATE = "opencode/session/child_update";
const CHILD_META = "opencode/child-session";
const NEEDS_OUTCOME = new Set(["claude", "acp"]); // these end with an explicit result: a bare exit is not a finished turn

// Labels, program names and WorkBuddy's script are shared facts (engine_facts.mjs). The protocol is this wrapper's own:
// how its output is read. WorkBuddy's headless output is Claude Code's stream-json, and it has its own sign-in; this
// wrapper does not take the WorkBuddy app's session.
const PROTOCOLS = { claude: "claude", codex: "codex", copilot: "copilot", antigravity: "antigravity", opencode: "acp", workbuddy: "claude" };
export const ENGINES = Object.fromEntries(Object.entries(ENGINE_FACTS).map(([id, f]) => [id, { ...f, protocol: PROTOCOLS[id] }]));

// The versions each engine's output translation was checked against (live runs, or recordings). Live 2026-11-23:
// codex 0.171.0 (gpt-6-luna), copilot 1.0.114, agy 1.5.14, opencode 2.0.20, claude 2.1.311 (scratchpad live check).
export const TESTED_VERSIONS = {
  claude: ["2.1.292", "2.1.311"],
  codex: ["0.166.0", "0.171.0"],
  copilot: ["1.0.107", "1.0.114"],
  antigravity: ["1.4.12", "1.5.14"],
  opencode: ["2.0.20", "2.0.20"],
};

// findBinary (the explicit bin, or the first match on PATH and the usual install folders) comes from engine_facts.mjs.
export { findBinary };

/** The Node.js that runs a script engine: `node` on PATH, else this process when it is Node itself. */
function findNode() {
  return findOnPath("node", defaultPathDirs()) || (/^node(\.exe)?$/.test(path.basename(process.execPath)) ? process.execPath : null);
}

/** What starts an engine's program: { cmd, prefix } (prefix = the arguments before its own). Null when a script has no Node. */
function runnerFor(id, binPath) {
  if (!ENGINES[id]?.script) return { cmd: binPath, prefix: [] };
  const node = findNode();
  return node ? { cmd: node, prefix: [binPath] } : null;
}

// childEnv (the caller's environment, minus Electron's switch and any names given in strip) comes from engine_facts.mjs.
export { childEnv };

const firstLine = (text) => String(text || "").trim().split("\n")[0].slice(0, 80) || null;

/** First line of `cmd [prefix] --version`, or null. Never throws; stdin is ignored so a program that reads it cannot hang the check. */
export async function engineVersion(cmd, { timeoutMs = 20000, prefix = [] } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timer = null;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    let child;
    try {
      child = spawn(cmd, [...prefix, "--version"], { env: childEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return finish(null);
    }
    timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout.on("data", (d) => { if (out.length < 4096) out += d; });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? firstLine(out) : null));
  });
}

/** Where a version stands against this engine's checked range (TESTED_VERSIONS, this wrapper's parser): tested, older, newer, unknown or unchecked. */
export function versionStatus(id, versionText) {
  return facts.versionStatus(versionText, TESTED_VERSIONS[id]);
}

const flatOptions = (opts) => (Array.isArray(opts) ? opts : [])
  .flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]))
  .filter((o) => o && typeof o.value === "string");

/** The values a configuration option offers (ACP: options[].value; grouped options included; a plain string also counts). */
const optionValues = (opts) => (Array.isArray(opts) ? opts : [])
  .flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]))
  .map((o) => (typeof o === "string" ? o : o?.value ?? o?.id))
  .filter((v) => typeof v === "string");

/** A wanted model as one of the engine's own options: id, name, or name without the provider. { value } or { value: null, near }. */
export function resolveModel(wanted, list = []) {
  const opts = (Array.isArray(list) ? list : []).filter((o) => o && typeof o.value === "string");
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
  const w = norm(wanted);
  const exact = opts.find((o) => norm(o.value) === w) || opts.find((o) => norm(o.name) === w);
  if (exact) return { value: exact.value, near: [] };
  const short = opts.find((o) => norm(String(o.name || "").split("/").pop()) === w || norm(o.value.split("/").pop()) === w);
  if (short) return { value: short.value, near: [] };
  const words = w.split(/[\s/._-]+/).filter((x) => x.length > 1);
  const score = (o) => words.filter((x) => norm(`${o.value} ${o.name}`).includes(x)).length;
  const near = opts.map((o) => [score(o), o.value]).filter(([n]) => n >= 1).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, v]) => v);
  return { value: null, near };
}

/**
 * The command line and stdin for one turn. mode "agent" may edit; anything else is read-only (fail closed, rule 6).
 * Never emits a permission-bypass flag: the engine's own checks stay on, and runTurn answers its questions.
 */
export function buildArgs(id, { prompt = "", mode = "agent", model, resumeId, cwd, systemPrompt } = {}) {
  const plan = mode !== "agent";
  // Rule 10: on a fresh conversation the identity goes in the message, in <instructions>; a resumed one already has it.
  const instructed = (p) => (systemPrompt && !resumeId ? `<instructions>\n${systemPrompt}\n</instructions>\n\n${p}` : p);
  const out = (args, stdin = null, extra = {}) => ({ args, stdin, keepStdinOpen: false, ...extra });
  switch (id) {
    case "claude": {
      const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--permission-mode", plan ? "plan" : "default", "--permission-prompt-tool", "stdio"];
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
      if (model) args.push("--model", model);
      if (resumeId) args.push("--resume", resumeId);
      // Rule 12: Claude Code reads its prompt from stdin and must keep stdin open while it may still ask questions.
      return out(args, `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`, { keepStdinOpen: true });
    }
    case "workbuddy": {
      // Claude Code's stream-json from CodeBuddy's CLI, without the stdio permission channel (the CLI rejects
      // --permission-prompt-tool, and nothing here answers its questions). So stdin is ignored and nothing is bypassed:
      // in agent mode the CLI's own default mode is the only gate, i.e. it does what that mode lets it do without asking.
      const args = ["-p", "--output-format", "stream-json", "--permission-mode", plan ? "plan" : "default"];
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
      if (model) args.push("--model", model);
      if (resumeId) args.push("--resume", resumeId);
      args.push(prompt);
      return out(args);
    }
    case "codex": {
      // Rule 12: codex exec reads stdin forever when it is open, so stdin is ignored (null).
      const args = ["exec"];
      if (resumeId) args.push("resume", resumeId);
      args.push("--json", "--skip-git-repo-check", "-c", `sandbox_mode="${plan ? "read-only" : "workspace-write"}"`);
      if (systemPrompt) args.push("-c", `developer_instructions=${JSON.stringify(systemPrompt)}`);
      if (model) args.push("-m", model);
      if (cwd && !resumeId) args.push("-C", cwd);
      args.push(prompt);
      return out(args);
    }
    case "copilot": {
      const args = ["-p", instructed(prompt), "--output-format", "json", "--disable-client-telemetry"];
      if (plan) args.push("--allow-tool", "read", "--deny-tool", "write", "--deny-tool", "shell", "--mode", "plan");
      else args.push("--allow-tool", "read", "--allow-tool", "write", "--deny-tool", "shell"); // shell needs a human: denied
      if (model) args.push("--model", model);
      if (resumeId) args.push("--resume", resumeId);
      return out(args);
    }
    case "antigravity": {
      const args = ["-p", instructed(prompt), "--output-format", "stream-json"];
      // Advisory: agy's own --sandbox let a write through (rule 7). runTurn holds a plan run in the OS sandbox on macOS
      // (launchFor, READ_ONLY_PROFILE); elsewhere plan mode is only as strong as the caller's enforcement.
      if (plan) args.push("--mode", "plan", "--sandbox");
      if (model) args.push("--model", model);
      if (resumeId) args.push("--conversation", resumeId);
      return out(args);
    }
    case "opencode":
      // ACP: the session, mode, model and prompt are set up over stdin inside runTurn (rules 4, 9, 10).
      return { args: ["acp"], stdin: "", keepStdinOpen: true, acp: true };
    default:
      throw new Error(`unknown engine: ${id}`);
  }
}

/**
 * Plain-language reason for an engine failure, with the next step (rules in engine_facts.mjs). `where` is the WorkBuddy
 * script that ran, if known. Unknown messages come back with the engine's name.
 */
export function explainError(id, message, where) {
  return facts.explainError(id, message, { where, settings: "your settings" });
}


const span = (ms) => {
  const n = ms >= 60000 ? Math.round(ms / 60000) : Math.round(ms / 1000);
  const unit = ms >= 60000 ? "minute" : "second";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const textOf = (c) => {
  if (c === undefined || c === null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(textOf).join("");
  if (c.type === "text") return String(c.text ?? "");
  if (c.type === "content") return textOf(c.content);
  if (c.type === "diff") return `diff ${c.path || ""}`;
  if (typeof c.text === "string") return c.text;
  return "";
};
const asInput = (v) => (v && typeof v === "object" ? v : {});

function addUsage(st, emit, u) {
  st.usage = { inputTokens: (st.usage?.inputTokens || 0) + u.inputTokens, outputTokens: (st.usage?.outputTokens || 0) + u.outputTokens };
  emit({ type: "usage", inputTokens: u.inputTokens, outputTokens: u.outputTokens });
}

// ---- translators: one parsed line in, normalised events out. Unknown shapes are ignored, never thrown on. ----

/** Claude Code stream-json (its sub-agents carry parent_tool_use_id). Control requests are handled by the caller. */
function onClaude(e, st, emit) {
  if (e.type === "system" && e.subtype === "init") {
    st.sessionId = e.session_id || st.sessionId;
    st.model = e.model || st.model;
    emit({ type: "session", id: st.sessionId, model: st.model });
    return;
  }
  const parent = e.parent_tool_use_id || null;
  const out = parent ? (ev) => emit({ type: "subagent", parent, event: ev }) : emit;
  if (e.type === "assistant") {
    for (const c of e.message?.content || []) {
      if (c?.type === "text" && c.text) { out({ type: "text", text: c.text }); if (!parent) st.text = c.text; }
      else if (c?.type === "thinking" && c.thinking) out({ type: "thinking", text: String(c.thinking) });
      else if (c?.type === "tool_use") out({ type: "tool_call", id: c.id, name: c.name, input: asInput(c.input) });
    }
    return;
  }
  if (e.type === "user") {
    for (const c of e.message?.content || []) {
      if (c?.type === "tool_result") out({ type: "tool_result", id: c.tool_use_id, output: textOf(c.content), isError: Boolean(c.is_error) });
    }
    return;
  }
  if (e.type === "result" && !parent) {
    const u = e.usage || {};
    if (e.usage) addUsage(st, emit, {
      inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
      outputTokens: num(u.output_tokens),
    });
    st.sessionId = e.session_id || st.sessionId;
    if (e.is_error || (e.subtype && e.subtype !== "success")) {
      st.outcome = "failed";
      // With no result text, the engine's last words (e.g. "Authentication required ...") say why; the subtype alone does not.
      const why = [e.subtype, st.text && st.text.slice(0, 300)].filter(Boolean).join(": ");
      st.error = (typeof e.result === "string" && e.result) || why || "the turn failed";
    } else {
      st.outcome = "completed";
      if (typeof e.result === "string" && e.result && !st.text) st.text = e.result;
    }
  }
}

/** GitHub Copilot JSONL (sub-agent events carry data.parentToolCallId; streamed text arrives as deltas). */
function onCopilot(e, st, emit) {
  const d = e.data || {};
  if (typeof e.type === "string" && e.type.startsWith("session.") && (d.sessionId || d.selectedModel || d.model)) {
    st.sessionId = d.sessionId || st.sessionId;
    st.model = d.selectedModel || d.model || st.model;
    emit({ type: "session", id: st.sessionId, model: st.model });
    return;
  }
  const parent = d.parentToolCallId || null;
  const key = parent || "";
  const out = parent ? (ev) => emit({ type: "subagent", parent, event: ev }) : emit;
  if (e.type === "assistant.message_delta") {
    if (d.deltaContent) { st.partials.set(key, (st.partials.get(key) || "") + d.deltaContent); out({ type: "text", text: d.deltaContent }); }
    return;
  }
  if (e.type === "assistant.message") {
    const content = String(d.content || "");
    const streamed = st.partials.has(key);
    const pieces = st.partials.get(key) || "";
    st.partials.delete(key);
    if (!streamed && content) out({ type: "text", text: content }); // streamed text was already sent as deltas
    if (!parent && (content || pieces)) st.text = content || pieces;
    return;
  }
  if (e.type === "tool.execution_start") {
    st.tools.set(d.toolCallId, d.toolName);
    const input = d.arguments && typeof d.arguments === "object" ? d.arguments : { input: String(d.arguments ?? "") };
    out({ type: "tool_call", id: d.toolCallId, name: d.toolName, input });
    return;
  }
  if (e.type === "tool.execution_complete") {
    const ok = Boolean(d.success);
    const body = ok ? (d.result?.content ?? "") : (d.error?.message ?? d.result?.content ?? "failed");
    out({ type: "tool_result", id: d.toolCallId, output: typeof body === "string" ? body : JSON.stringify(body), isError: !ok });
    return;
  }
  if (!parent && e.type === "result") {
    if (e.sessionId) st.sessionId = e.sessionId;
    if (e.exitCode === 0) st.outcome = "completed";
    else { st.outcome = "failed"; st.error = `GitHub Copilot ended with exit code ${e.exitCode}`; }
  }
}

/** Codex exec --json. */
function onCodex(e, st, emit) {
  if (e.type === "thread.started") {
    st.sessionId = e.thread_id || st.sessionId;
    emit({ type: "session", id: st.sessionId, model: st.model });
    return;
  }
  const it = e.item || {};
  if (e.type === "item.started" && it.type === "command_execution") {
    emit({ type: "tool_call", id: it.id, name: "shell", input: { command: it.command } });
    return;
  }
  if (e.type === "item.completed") {
    if (it.type === "agent_message" && it.text) { emit({ type: "text", text: it.text }); st.text = it.text; }
    else if (it.type === "reasoning" && it.text) emit({ type: "thinking", text: String(it.text) });
    else if (it.type === "command_execution") {
      emit({ type: "tool_result", id: it.id, output: String(it.aggregated_output ?? ""), isError: !(it.exit_code === 0 || it.status === "completed") });
    } else if (it.type === "file_change") {
      const files = (it.changes || []).map((c) => `${c.kind} ${c.path}`);
      emit({ type: "tool_call", id: it.id, name: "edit", input: { files } });
      emit({ type: "tool_result", id: it.id, output: files.join("\n"), isError: it.status === "failed" });
    } else if (it.type === "mcp_tool_call" || it.type === "web_search") {
      emit({ type: "tool_call", id: it.id, name: it.type === "web_search" ? "web_search" : `${it.server}.${it.tool}`, input: it.query ? { query: it.query } : asInput(it.arguments) });
      emit({ type: "tool_result", id: it.id, output: textOf(it.result ?? it.error ?? ""), isError: it.status === "failed" });
    }
    return;
  }
  if (e.type === "error") { st.error = e.message || st.error; return; }
  if (e.type === "turn.failed") { st.outcome = "failed"; st.error = e.error?.message || JSON.stringify(e.error || {}); return; }
  if (e.type === "turn.completed") {
    st.outcome = "completed";
    const u = e.usage;
    if (u && (u.input_tokens || u.output_tokens)) addUsage(st, emit, { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) });
  }
}

/** Antigravity print mode stream-json: {event, <event>: {...}} (agy 1.4.12, recorded live). */
function onAgy(e, st, emit) {
  const kind = e.event;
  const body = (kind && typeof e[kind] === "object" && e[kind]) || {};
  const conv = body.conversation_id || e.conversation_id;
  if (conv && !st.announced) { st.announced = true; st.sessionId = conv; emit({ type: "session", id: conv, model: st.model }); }
  const errText = (v) => (typeof v === "string" ? v : JSON.stringify(v));
  if (kind === "step_update") {
    const key = String(body.step_index ?? st.tools.size);
    const done = body.state === "DONE";
    if (body.step_type === "tool") {
      const ti = body.tool_info || {};
      const name = ti.name || body.tool_name || "tool";
      if (!st.tools.has(key)) { st.tools.set(key, name); emit({ type: "tool_call", id: key, name, input: asInput(ti.parameters) }); }
      if (done && !st.tools.has(`${key}:done`)) {
        st.tools.set(`${key}:done`, true);
        const output = ti.output ?? ti.error ?? "";
        emit({ type: "tool_result", id: key, output: typeof output === "string" ? output : JSON.stringify(output), isError: Boolean(ti.error) });
      }
      return;
    }
    if (body.step_type === "agent_response") {
      if (typeof body.text_delta === "string" && body.text_delta) { st.partial += body.text_delta; emit({ type: "text", text: body.text_delta }); }
      if (done && st.partial) { st.text = st.partial; st.partial = ""; }
    }
    return;
  }
  if (kind === "result") {
    if (st.partial) { st.text = st.partial; st.partial = ""; }
    if (body.status !== "SUCCESS" || body.error) {
      st.outcome = "failed";
      st.error = errText(body.error || body.response || body.finished_reason || "Antigravity reported an error");
    } else {
      st.outcome = "completed";
      if (typeof body.response === "string" && body.response && !st.text) { emit({ type: "text", text: body.response }); st.text = body.response; }
    }
  }
}

// ---- ACP (OpenCode): session updates and sub-agents ----

/** One session/update (or a sub-agent's update, with isMain false) as events; st keeps the latest message's text. */
function acpUpdate(u, st, out, isMain) {
  if (u.sessionUpdate === "agent_message_chunk") {
    const t = textOf(u.content);
    if (!t) return;
    if (isMain) {
      if (u.messageId && u.messageId !== st.messageId) { st.messageId = u.messageId; st.text = ""; }
      st.text += t;
    }
    out({ type: "text", text: t });
    return;
  }
  if (u.sessionUpdate === "agent_thought_chunk") { const t = textOf(u.content); if (t) out({ type: "thinking", text: t }); return; }
  if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") acpTool(u, st, out);
}

/** A tool call is shown once its input is known (OpenCode first sends it empty), and ends with one result. */
function acpTool(u, st, out) {
  const id = String(u.toolCallId || "");
  if (!id) return;
  const ended = u.status === "completed" || u.status === "failed";
  let t = st.tools.get(id);
  if (!t) { t = { name: String(u.name || u.title || u.kind || "tool"), shown: false, done: false, isSub: false, description: "", claimed: false }; st.tools.set(id, t); }
  if (String(u.title || "").toLowerCase() === "subagent") t.isSub = true;
  const input = u.rawInput && typeof u.rawInput === "object" ? u.rawInput : u.args && typeof u.args === "object" ? u.args : null;
  if (t.isSub && input?.description && !t.description) t.description = String(input.description);
  const says = input && Object.keys(input).some((k) => !WHERE_KEYS.has(k));
  if (!t.shown && (says || ended || u.status === "in_progress")) {
    t.shown = true;
    out({ type: "tool_call", id, name: t.name, input: input || {} });
  }
  if (ended && !t.done) {
    t.done = true;
    out({ type: "tool_result", id, output: textOf(u.content) || (u.status === "completed" ? "done" : "failed"), isError: u.status === "failed" });
  }
}

/** A sub-agent's own update, wrapped under the sub-agent call that started it (matched by its description). */
function acpChild(p, st, emit) {
  const cid = String(p.childSessionId || "");
  if (!cid) return;
  let parent = st.childParent.get(cid);
  if (!parent) {
    const title = String(p.title || "");
    const open = [...st.tools.entries()].filter(([, t]) => t.isSub && !t.claimed);
    const hit = open.find(([, t]) => t.description === title) || open[0];
    if (hit) hit[1].claimed = true;
    parent = hit ? hit[0] : cid;
    st.childParent.set(cid, parent);
  }
  if (p.type !== "update" || !p.update || typeof p.update !== "object") return;
  let cs = st.childState.get(cid);
  if (!cs) { cs = { text: "", tools: new Map() }; st.childState.set(cid, cs); }
  acpUpdate({ ...p.update }, cs, (ev) => emit({ type: "subagent", parent, event: ev }), false);
}

// ---- the process ----

const versions = new Map();
async function cachedVersion(binPath, runner) {
  let key = binPath;
  try { key += `|${fs.statSync(binPath).mtimeMs}`; } catch { /* as given */ }
  if (!versions.has(key)) versions.set(key, await engineVersion(runner.cmd, { timeoutMs: VERSION_MS, prefix: runner.prefix }));
  return versions.get(key);
}

const EMPTY = { status: "failed", text: "", sessionId: null, model: null, exitCode: null, error: null, usage: null, version: null, sandboxed: false };

// Plan runs of these engines are held by the OS (rule 7): their own read-only mode is only a request. Writes are denied
// everywhere except what the engine needs; the workspace is denied last, so it stays read-only under a temp folder too.
// Each path is listed in both spellings (/var and /private/var, /tmp and /private/tmp).
const HELD_ENGINES = new Set(["antigravity", "opencode"]);
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const READ_ONLY_PROFILE = `(version 1)(allow default)(deny file-write*)
(allow file-write*
  (subpath "/dev") (subpath "/private/var/folders") (subpath "/var/folders") (subpath "/private/tmp") (subpath "/tmp")
  (subpath (string-append (param "HOME") "/.gemini")) (subpath (string-append (param "HOME") "/.local/share"))
  (subpath (string-append (param "HOME") "/.local/state")) (subpath (string-append (param "HOME") "/.cache"))
  (subpath (string-append (param "HOME") "/.config/opencode")) (subpath (string-append (param "HOME") "/Library/Caches"))
  (subpath (string-append (param "HOME") "/Library/Application Support/Antigravity")))
(deny file-write* (subpath (param "WS")))`;

/** What a turn really starts: the engine itself, or sandbox-exec around it when a read-only run is held on macOS. */
function launchFor(engine, binPath, args, { mode, cwd, sandbox }) {
  const held = sandbox !== false && mode !== "agent" && HELD_ENGINES.has(engine) && process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
  if (!held) return { cmd: binPath, args, sandboxed: false };
  let ws = cwd;
  try { ws = fs.realpathSync(cwd); } catch { /* as given */ }
  return { cmd: SANDBOX_EXEC, args: ["-p", READ_ONLY_PROFILE, "-D", `HOME=${os.homedir()}`, "-D", `WS=${ws}`, binPath, ...args], sandboxed: true };
}

/**
 * Run one turn of an engine. Resolves (never rejects) with
 * { status: completed|failed|timeout|idle|aborted|not_found, text, sessionId, model, exitCode, error, usage, version, sandboxed }.
 * Events go to onEvent in the normalised shapes listed in the spec. approve decides the engine's questions in agent mode.
 * sandbox (default true): false turns off the OS hold of a read-only antigravity or opencode run on macOS. That is the
 * caller's choice; result.sandboxed says whether the run was held.
 */
export async function runTurn(opts = {}) {
  const { engine, prompt = "", cwd = process.cwd(), mode = "agent", model, resumeId, systemPrompt, bin, env: extraEnv = {},
    timeoutMs = 30 * 60e3, idleMs = 10 * 60e3, signal, onEvent = () => {}, approve, sandbox = true } = opts;
  const spec = ENGINES[engine];
  if (!spec) return { ...EMPTY, error: `unknown engine: ${engine}` };
  const binPath = findBinary(engine, { bin });
  if (!binPath) return { ...EMPTY, status: "not_found", error: `${spec.label} is not installed (or not found). Install it, or pass its path as bin.` };
  const runner = runnerFor(engine, binPath);
  if (!runner) return { ...EMPTY, status: "not_found", error: `${spec.label} runs as a Node script, and Node.js was not found on PATH. Install Node.js.` };
  if (signal?.aborted) return { ...EMPTY, status: "aborted", error: "stopped by the caller" };
  const version = await cachedVersion(binPath, runner);
  const plan = buildArgs(engine, { prompt, mode, model, resumeId, cwd, systemPrompt });
  const launch = launchFor(engine, runner.cmd, [...runner.prefix, ...plan.args], { mode, cwd, sandbox });
  return runProcess({ engine, protocol: spec.protocol, label: spec.label, launch, plan, cwd, env: { ...childEnv(), ...extraEnv }, where: binPath,
    prompt, mode, model, resumeId, systemPrompt, version, timeoutMs, idleMs, signal, approve,
    emit: (ev) => { try { onEvent(ev); } catch { /* a broken sink is the caller's bug; it must not kill the turn */ } } });
}

function runProcess(ctx) {
  const { engine, protocol, label, launch, plan, cwd, env, where, prompt, mode, model, resumeId, systemPrompt, version, timeoutMs, idleMs, signal, approve, emit } = ctx;
  return new Promise((resolve) => {
    const st = { text: "", partial: "", partials: new Map(), messageId: null, sessionId: resumeId || null, model: model || null,
      outcome: null, error: null, usage: null, tools: new Map(), childParent: new Map(), childState: new Map(), announced: false };
    const acp = protocol === "acp";
    let child = null;
    let done = false;
    let endStatus = null;
    let endMessage = null;
    let wrapping = false;
    let wrapKilled = false;
    let spawnError = null;
    let exitCode = null;
    let exitSignal = null;
    let stderr = "";
    let buf = "";
    let pendingApprovals = 0;
    let nextId = 0;
    let loading = false;
    let sessionId = null;
    const pending = new Map();
    const timers = new Set();
    let idle = null;
    let overall = null;

    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    const drop = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };
    const stopIdle = () => { drop(idle); idle = null; };
    // Rule 12 (bounded waits): the idle clock stops while a question waits for an approver; the overall limit still applies.
    const touch = () => {
      stopIdle();
      if (!done && !wrapping && pendingApprovals === 0) idle = later(() => terminate("idle", `${label} sent nothing for ${span(idleMs)}; it was stopped.`), idleMs);
    };
    const signalGroup = (sig) => { if (child?.pid) { try { process.kill(-child.pid, sig); } catch { /* already gone */ } } };
    const send = (obj) => { try { if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* the process is gone */ } };
    const endStdin = () => { try { if (child?.stdin?.writable) child.stdin.end(); } catch { /* gone */ } };

    const finalize = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      signal?.removeEventListener("abort", onAbort);
      for (const r of pending.values()) r({ error: { message: "stopped" } });
      pending.clear();
      signalGroup("SIGKILL"); // rule 12: nothing the engine started may outlive the turn
      try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch { /* closed */ }
      resolve(buildResult());
    };

    // Ends the turn: a status set now wins; the process is asked to stop (ACP: cancel first), then killed in bounded steps.
    function terminate(status, message) {
      if (done || endStatus) return;
      endStatus = status;
      endMessage = message || null;
      stopIdle();
      drop(overall);
      if (acp) {
        if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        later(() => signalGroup("SIGTERM"), KILL_AFTER_MS);
        later(() => signalGroup("SIGKILL"), 2 * KILL_AFTER_MS);
        later(finalize, 2 * KILL_AFTER_MS + 1000);
      } else {
        signalGroup("SIGTERM");
        later(() => signalGroup("SIGKILL"), KILL_AFTER_MS);
        later(finalize, KILL_AFTER_MS + 1000);
      }
    }
    const onAbort = () => terminate("aborted", "stopped by the caller");

    // The turn's last line is in: close stdin and give the process a bounded moment to exit on its own (rule 12).
    function wrapUp() {
      if (wrapping || done) return;
      wrapping = true;
      stopIdle();
      drop(overall);
      endStdin();
      later(() => { wrapKilled = true; signalGroup("SIGTERM"); }, WRAP_UP_MS);
      later(() => signalGroup("SIGKILL"), WRAP_UP_MS + KILL_AFTER_MS);
      later(finalize, WRAP_UP_MS + KILL_AFTER_MS + 1000);
    }

    function buildResult() {
      const tail = stderr.trim();
      const exitWhat = exitCode !== null ? `exited with code ${exitCode}` : exitSignal ? `killed by signal ${exitSignal}` : "exited";
      const failWith = (msg) => explainError(engine, msg, where);
      let status;
      let error = null;
      if (endStatus) { status = endStatus; error = endMessage; }
      else if (spawnError) { status = "failed"; error = failWith(spawnError); }
      else if (st.outcome === "aborted") { status = "aborted"; error = st.error || "stopped by the caller"; }
      else if (st.outcome === "failed") { status = "failed"; error = failWith(st.error || tail || exitWhat); }
      else if (st.outcome === "completed") {
        if (wrapKilled || exitCode === 0) status = "completed";
        else { status = "failed"; error = failWith(tail || exitWhat); }
      } else if (!NEEDS_OUTCOME.has(protocol) && exitCode === 0) status = "completed";
      else {
        status = "failed";
        error = failWith(`ended before its answer was complete (${[exitWhat, tail].filter(Boolean).join("; ")})`);
      }
      return { status, text: st.text || "", sessionId: st.sessionId || null, model: st.model || null,
        exitCode: exitCode ?? null, error, usage: st.usage || null, version: version || null, sandboxed: launch.sandboxed };
    }

    // Spawn. Rule 12: detached (its own process group), stdin ignored for codex, otherwise a pipe.
    try {
      child = spawn(launch.cmd, launch.args, { cwd, env, detached: true, windowsHide: true, stdio: [plan.stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (err) {
      spawnError = err.message;
      return resolve(buildResult());
    }
    child.stdin?.on("error", () => { /* EPIPE when it exits first */ });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
    child.stdout.on("data", (chunk) => {
      touch();
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
        nl = buf.indexOf("\n");
      }
      if (buf.length > MAX_LINE) terminate("failed", `${label} wrote a single line larger than ${MAX_LINE} bytes.`);
    });
    child.stdout.on("end", () => { if (buf.trim()) onLine(buf); buf = ""; });
    child.on("error", (err) => { spawnError = err.message; finalize(); });
    child.on("exit", (code, sig) => { exitCode = code; exitSignal = sig; later(finalize, DRAIN_MS); });
    child.on("close", () => finalize());

    if (plan.stdin) child.stdin.write(plan.stdin);
    if (!plan.keepStdinOpen && plan.stdin !== null) endStdin();
    overall = later(() => terminate("timeout", `${label} ran past the ${span(timeoutMs)} limit; it was stopped.`), timeoutMs);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort(); // aborted while the version check ran: a listener added now would never fire
    }
    touch();

    // ---- decisions: one authority (rule 5). Plan mode allows reads only; agent mode asks approve, and with none it refuses.
    async function decide({ tool, input, readOnly }) {
      if (mode !== "agent") {
        const allow = readOnly && tool !== "ExitPlanMode"; // rule 6: ExitPlanMode is never allowed here
        return { allow, reason: allow ? "" : "Plan mode: only reading is allowed in this run." };
      }
      if (typeof approve !== "function") return { allow: false, reason: "No one is here to approve this, so it was refused." };
      pendingApprovals++;
      stopIdle();
      try {
        const ok = await approve({ engine, tool, input, mode });
        return { allow: ok === true, reason: ok === true ? "" : "The user did not approve this." };
      } catch (err) {
        return { allow: false, reason: `The approval failed: ${err.message}` };
      } finally {
        pendingApprovals--;
        touch();
      }
    }

    async function onControl(msg) {
      const req = msg.request || {};
      if (req.subtype !== "can_use_tool") {
        send({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `agent_wrap does not offer ${req.subtype}` } });
        return;
      }
      const tool = String(req.tool_name || "tool");
      const input = asInput(req.input);
      const v = await decide({ tool, input, readOnly: READ_TOOLS.has(tool) });
      emit({ type: "permission", tool, input, allowed: v.allow });
      const response = v.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: v.reason };
      send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
    }

    async function acpPermission(msg) {
      const p = msg.params || {};
      const tc = p.toolCall || {};
      const kind = String(tc.kind || "");
      const tool = String(tc.title || tc.name || kind || "tool");
      const input = asInput(tc.rawInput);
      const v = await decide({ tool, input, readOnly: ACP_READ_KINDS.has(kind) });
      emit({ type: "permission", tool, input, allowed: v.allow });
      const options = Array.isArray(p.options) ? p.options : [];
      const want = v.allow ? "allow" : "reject";
      const pick = options.find((o) => o?.kind === `${want}_once`) || options.find((o) => String(o?.kind || "").startsWith(want));
      send({ jsonrpc: "2.0", id: msg.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
    }

    // ---- ACP client (rule 4: mode and model are set on every turn; rule 9: the model is resolved against the engine's own list)
    function request(method, params) {
      return new Promise((res) => {
        if (done) return res({ error: { message: "stopped" } });
        const id = ++nextId;
        pending.set(id, res);
        send({ jsonrpc: "2.0", id, method, params });
      });
    }
    const fail = (message) => { st.outcome = "failed"; st.error = message; wrapUp(); };

    async function runAcp() {
      const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { [CHILD_CAPABILITY]: true } } });
      if (init.error) return fail(`could not start its ACP session: ${init.error.message || "initialize failed"}`);
      const caps = init.result?.agentCapabilities || {};
      let r;
      if (resumeId) {
        if (!(caps.loadSession || caps.load_session)) return fail(`${label} cannot continue an earlier conversation; start a new one without resumeId.`);
        loading = true;
        r = await request("session/load", { sessionId: resumeId, cwd, mcpServers: [] });
        loading = false;
        if (r.error) return fail(`the earlier conversation could not be continued (${String(r.error.message || "").slice(0, 160)})`);
        sessionId = resumeId;
      } else {
        r = await request("session/new", { cwd, mcpServers: [] });
        if (r.error || !r.result?.sessionId) return fail(`could not open a session: ${r.error?.message || "no session id"}`);
        sessionId = r.result.sessionId;
      }
      const sess = r.result || {};
      st.sessionId = sessionId;
      const modeIds = Array.isArray(sess.modes?.availableModes) ? sess.modes.availableModes.map((m) => m?.id) : [];
      const modeOpt = Array.isArray(sess.configOptions) ? sess.configOptions.find((o) => o?.id === "mode") : null;
      const planMode = mode !== "agent";
      const target = planMode ? "plan" : "build";
      if (modeIds.length) {
        if (modeIds.includes(target)) {
          const m = await request("session/set_mode", { sessionId, modeId: target });
          if (m.error) return fail(`could not switch to ${target} mode: ${m.error.message}`); // read-only must hold: fail closed
        } else if (planMode) return fail(`${label} has no plan mode, so a read-only run cannot be held.`);
      } else if (modeOpt) {
        // OpenCode 2.0.20 lists no session modes: its mode is a configOption "mode". A session keeps the mode it was left
        // in, so it is set on every turn, new or resumed (SKILL rule 4).
        if (optionValues(modeOpt.options).includes(target)) {
          const m = await request("session/set_config_option", { sessionId, configId: "mode", value: target });
          if (m.error) return fail(`could not switch to ${target} mode: ${String(m.error.message || "").slice(0, 160)}`); // fail closed
        } else if (planMode) return fail(`${label} has no plan mode, so a read-only run cannot be held.`);
      } else if (planMode && !launch.sandboxed) {
        // No mode of any kind is offered: only the OS sandbox can hold a read-only run.
        return fail(`${label} offers no mode setting, so a read-only run cannot be held without the OS sandbox.`);
      }
      if (model) {
        const listed = Array.isArray(sess.models?.availableModels)
          ? sess.models.availableModels.map((m) => ({ value: String(m?.modelId ?? ""), name: String(m?.name ?? "") })) : null;
        const modelOpt = Array.isArray(sess.configOptions) ? sess.configOptions.find((o) => o?.id === "model") : null;
        const options = listed || (modelOpt ? flatOptions(modelOpt.options) : []);
        if (options.length) {
          const pick = resolveModel(model, options);
          if (!pick.value) return fail(`${label} does not offer the model "${model}"${pick.near.length ? `; close matches: ${pick.near.join(", ")}` : ""}. Change it in Settings (the id the engine lists).`);
          const m = listed
            ? await request("session/set_model", { sessionId, modelId: pick.value })
            : await request("session/set_config_option", { sessionId, configId: "model", value: pick.value });
          // Skip quietly only when the engine has no such method; any other refusal means the model was not chosen.
          if (m.error && m.error.code !== -32601) return fail(`model ${pick.value} could not be chosen: ${String(m.error.message || "").slice(0, 160)}`);
          if (!m.error) st.model = pick.value;
        }
      }
      emit({ type: "session", id: sessionId, model: st.model });
      const text = resumeId || !systemPrompt ? prompt : `<instructions>\n${systemPrompt}\n</instructions>\n\n${prompt}`;
      const turn = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      if (turn.error) {
        const kind = turn.error.data?.errorName ? String(turn.error.data.errorName) : "";
        const note = st.model && (!kind || /^provider\./.test(kind)) ? ` (model ${st.model})` : "";
        return fail(`${turn.error.message || "the turn failed"}${note}`);
      }
      const u = turn.result?.usage;
      if (u) addUsage(st, emit, { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens) + num(u.thoughtTokens) });
      const stop = turn.result?.stopReason;
      if (stop === "end_turn") st.outcome = "completed";
      else if (stop === "cancelled") { st.outcome = "aborted"; st.error = st.error || "stopped"; }
      else if (stop === "refusal") return fail("the engine refused this request");
      else return fail(`the turn stopped without an answer (${stop || "no reason"})`);
      wrapUp();
    }

    function acpFeed(msg) {
      if (msg.id !== undefined && !msg.method) {
        const r = pending.get(msg.id);
        pending.delete(msg.id);
        if (r) r(msg);
        return;
      }
      if (msg.method === "session/update") {
        if (loading) return;
        const u = msg.params?.update || {};
        const cm = u._meta?.[CHILD_META];
        if (cm?.id) acpChild({ childSessionId: String(cm.id), title: cm.title, type: "update", update: u }, st, emit);
        else acpUpdate(u, st, emit, true);
        return;
      }
      if (msg.method === CHILD_UPDATE) { if (!loading) acpChild(msg.params || {}, st, emit); return; }
      if (msg.method === "session/request_permission" && msg.id !== undefined) { acpPermission(msg).catch(() => {}); return; }
      // Rule 5/12: anything else the engine asks (files, terminals) is not offered.
      if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `agent_wrap does not offer ${msg.method}` } });
    }

    function onMessage(msg) {
      if (acp) return acpFeed(msg);
      if (protocol === "claude") {
        if (msg.type === "control_request") { onControl(msg).catch(() => {}); return; }
        onClaude(msg, st, emit);
        if (msg.type === "result") wrapUp();
        return;
      }
      // The Copilot CLI prints its result and then lingers (WorkMate ends it 4 s later): the turn ends at the result.
      if (protocol === "copilot") { onCopilot(msg, st, emit); if (msg.type === "result") wrapUp(); return; }
      if (protocol === "codex") return onCodex(msg, st, emit);
      if (protocol === "antigravity") return onAgy(msg, st, emit);
    }

    function onLine(raw) {
      if (done) return;
      const line = raw.trim();
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { emit({ type: "raw", line }); return; }
      if (!msg || typeof msg !== "object") { emit({ type: "raw", line }); return; }
      try { onMessage(msg); } catch { /* a shape we do not read is ignored (contract) */ }
    }

    if (acp) runAcp().catch((err) => fail(err.message));
  });
}

// ---- CLI ----

const USAGE = `usage:
  node agent_wrap.mjs --detect
  node agent_wrap.mjs [--engine ${Object.keys(ENGINES).join("|")}] [--mode plan|agent] [--model M] [--resume ID]
                      [--cwd DIR] [--timeout S] [--json] "prompt"
Agent mode has no approver here: the engine's questions are refused. Pass approve() from code to answer them.`;

function parseArgs(argv) {
  const o = { engine: "claude", mode: "agent", model: undefined, resume: undefined, cwd: undefined, timeout: undefined, json: false, detect: false, help: false, prompt: [] };
  let positional = false;
  let i = 0;
  const value = (flag) => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`); i++; return argv[i]; };
  while (i < argv.length) {
    const a = argv[i];
    if (positional) o.prompt.push(a);
    else if (a === "--") positional = true;
    else if (a === "--engine") o.engine = value(a);
    else if (a === "--mode") o.mode = value(a);
    else if (a === "--model") o.model = value(a);
    else if (a === "--resume") o.resume = value(a);
    else if (a === "--cwd") o.cwd = value(a);
    else if (a === "--timeout") o.timeout = Number(value(a));
    else if (a === "--json") o.json = true;
    else if (a === "--detect") o.detect = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.prompt.push(a);
    i++;
  }
  return o;
}

async function detect() {
  const rows = await Promise.all(Object.entries(ENGINES).map(async ([id, e]) => {
    const bin = findBinary(id);
    const runner = bin ? runnerFor(id, bin) : null;
    const version = runner ? await engineVersion(runner.cmd, { prefix: runner.prefix }) : null;
    return { id, label: e.label, bin, version, status: bin ? versionStatus(id, version).status : "not found" };
  }));
  for (const r of rows) {
    console.log(`${r.id.padEnd(12)} ${(r.bin || "not found").padEnd(44)} ${(r.version || "-").padEnd(14)} ${r.status}`);
  }
  return 0;
}

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (err) { console.error(`${err.message}\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  if (o.detect) return detect();
  if (o.prompt.length === 0) { console.error(USAGE); return 2; }
  if (!ENGINES[o.engine]) { console.error(`unknown engine ${o.engine}; one of: ${Object.keys(ENGINES).join(", ")}`); return 2; }
  if (o.mode !== "agent" && o.mode !== "plan") { console.error("--mode must be plan or agent"); return 2; }
  const timeoutMs = o.timeout === undefined ? undefined : o.timeout * 1000;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) { console.error("--timeout must be a positive number of seconds"); return 2; }
  const ac = new AbortController();
  const onInt = () => {
    if (ac.signal.aborted) process.exit(130); // a second Ctrl-C forces the exit
    ac.abort();
    process.stderr.write("stopping (Ctrl-C again to force)\n");
  };
  process.on("SIGINT", onInt);
  let lastChar = "\n";
  const res = await runTurn({
    engine: o.engine, prompt: o.prompt.join(" "), cwd: path.resolve(o.cwd || process.cwd()), mode: o.mode,
    model: o.model, resumeId: o.resume, timeoutMs, signal: ac.signal,
    onEvent: (ev) => {
      if (o.json) console.log(JSON.stringify(ev));
      else if (ev.type === "text") { process.stdout.write(ev.text); lastChar = ev.text.slice(-1) || lastChar; }
    },
  });
  process.off("SIGINT", onInt);
  if (o.json) console.log(JSON.stringify({ type: "result", ...res }));
  else {
    if (lastChar !== "\n") process.stdout.write("\n");
    const vs = res.version ? versionStatus(o.engine, res.version) : null;
    const note = vs && vs.status !== "tested" ? ` (version ${res.version} is ${vs.status} than the tested range ${vs.tested.join("-")})` : "";
    console.error(`[agent_wrap] ${res.status}${res.error ? `: ${res.error}` : ""}${note}`);
  }
  return res.status === "completed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
