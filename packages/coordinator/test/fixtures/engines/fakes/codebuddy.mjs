#!/usr/bin/env node
// Fake WorkBuddy's CodeBuddy Code CLI (codebuddy-lite-wb.mjs, 2.165.0), run by agent_wrap as
// `node <script> -p --output-format stream-json --permission-mode <plan|default> [--append-system-prompt S] [--model M]
// [--resume ID] <prompt>`. It speaks Claude Code's stream-json on stdout. It reads no stdin (the wrapper ignores it).
//   FAIL_AUTH   the reply it gives when signed out: an assistant text, then an error result, exit 0
//   HANG        prints nothing and never exits
//   anything    a normal answer
// Every run logs argv, the stdin kind, pid and cwd to $FAKE_LOG.
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.165.0"); process.exit(0); }
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const prompt = args[args.length - 1] ?? "";
const resume = opt("--resume");
const sid = resume || "cb-sess-1";
const stdinKind = () => {
  try { const s = fs.fstatSync(0); return s.isSocket() || s.isFIFO() ? "pipe" : s.isCharacterDevice() ? "null" : "other"; } catch { return "closed"; }
};
if (process.env.FAKE_LOG) {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ engine: "workbuddy", args, stdin: stdinKind(), pid: process.pid, cwd: process.cwd() }));
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

out({ type: "system", subtype: "init", session_id: sid, model: "default-model", permissionMode: opt("--permission-mode") });
if (/HANG/.test(prompt)) { setInterval(() => {}, 1000); }
else if (/FAIL_AUTH/.test(prompt)) {
  out({ type: "assistant", message: { content: [{ type: "text", text: "Authentication required. Please use /login command to sign in." }] }, session_id: sid });
  out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid });
  process.exit(0);
} else {
  out({ type: "assistant", message: { content: [{ type: "text", text: resume ? `codebuddy continued ${resume}` : "codebuddy says hello" }] }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: sid, usage: { input_tokens: 3, output_tokens: 2 } });
}
