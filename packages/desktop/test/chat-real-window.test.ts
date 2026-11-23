import { whenElectronExited } from "./helpers/electron-exit.js";
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

// Real Electron window with the Preact shell and its chat view. Each size is one turn typed into
// the composer: the answer streams in, the finished turn keeps it, and Stop ends a streaming turn
// as stopped. 960x740 is the minimum size; 1920x1080 is the full-screen size the harness uses.
// The model is a local OpenAI-compatible stub, so an answer must be the stub's text, not a status
// line. A missing model must end in the error state, never as a finished answer.
const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "..", "..");
const shotDir = process.env.OPENSAND_CHAT_SHOT_DIR || path.join(repoRoot, ".opensand-snapshots", "chat");
const SIZES: Array<[number, number, string]> = [[960, 740, "960x740"], [1920, 1080, "full-1920x1080"]];
const PROMPT = "Summarize the workspace.";
const ANSWER_MODEL = "stub-model";
const SLOW_MODEL = "slow-model";
// The answer is deliberately long so the finished state also covers the long-message
// screen: the feed scrolls, the page itself never overflows horizontally.
const STUB_ANSWER =
  "CHAT ANSWER: the workspace has three packages.\n\n" +
  "The desktop package owns the Electron main process and the bridge; the engine package " +
  "runs the local model loop and the mission store; the protocol package carries the " +
  "message shapes both sides share.\n\n" +
  "For a first change, start in packages/desktop/src/shell: the models there are pure " +
  "state machines, so they test without Electron and the views stay thin.";
const PARTIAL_ANSWER = "CHAT PARTIAL: reading the files";

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

// A local OpenAI-compatible server in the shape llm-client.ts parses: SSE lines with
// choices[0].delta, then [DONE]. The slow model sends one chunk, then holds the stream so a person
// (or this test) can press Stop. Any other model name gets a 404 with an Ollama-style error body.
async function startStub(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw || "{}");
      if (body.model !== ANSWER_MODEL && body.model !== SLOW_MODEL) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `model "${body.model}" not found, try pulling it first` } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta: unknown, finish?: string) =>
        res.write(`data: ${JSON.stringify({ choices: [finish ? { delta, finish_reason: finish } : { delta }] })}\n\n`);

      if (body.model === SLOW_MODEL) {
        chunk({ role: "assistant", content: PARTIAL_ANSWER });
        const timer = setTimeout(() => {
          timers.delete(timer);
          chunk({ content: " and more." });
          chunk({}, "stop");
          res.end("data: [DONE]\n\n");
        }, 4000);
        timers.add(timer);
        // A stopped turn aborts the request; the held chunk must not write to a closed socket.
        req.on("close", () => { clearTimeout(timer); timers.delete(timer); });
        return;
      }

      // Paced chunks: streaming lasts long enough for a 100ms poll to see it, as a
      // real model streaming sentence by sentence does. No req close guard here:
      // IncomingMessage fires close as soon as the request body is read, which
      // would cancel the response before it starts.
      const deltas = [
        { role: "assistant", content: STUB_ANSWER.slice(0, 60) },
        { content: STUB_ANSWER.slice(60, 200) },
        { content: STUB_ANSWER.slice(200) },
      ];
      const paced = deltas.map((delta, i) => setTimeout(() => {
        timers.delete(paced[i]);
        chunk(delta);
        if (i === deltas.length - 1) {
          chunk({}, "stop");
          res.end("data: [DONE]\n\n");
        }
      }, 250 * (i + 1)));
      for (const t of paced) timers.add(t);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.close(() => resolve());
      }),
  };
}

const RUNNER_HEAD = String.raw`
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
const shotDir = process.env.OPENSAND_CHAT_SHOT_DIR || "";
const SIZES = JSON.parse(process.env.OPENSAND_CHAT_SIZES || "[]");
const TIMEOUT_MS = Number(process.env.OPENSAND_CHAT_TIMEOUT_MS || 150000);
const PROMPT = process.env.OPENSAND_CHAT_PROMPT || "Summarize the workspace.";
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 90)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}
// Types into the Preact-controlled textarea the way a person does: set the value through the
// prototype setter, then fire input so onInput runs.
const type = async (text) => {
  await js("(() => { const t = document.querySelector('#promptInput'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, " + JSON.stringify(text) + "); t.dispatchEvent(new Event('input', { bubbles: true })); })()");
};
// Opens the first Inbox item and clicks Approve Once. Returns the approval id, or "" when none is listed.
const approveFromInbox = async () => {
  const id = await js("(() => { const item = document.querySelector('.inbox-item'); if (!item) return ''; if (item.getAttribute('aria-expanded') !== 'true') item.click(); return item.getAttribute('data-approval-id') || ''; })()");
  if (!id) return "";
  await wait("[...document.querySelectorAll('.inbox-decision-row button')].some((b) => b.textContent === 'Approve Once')");
  await js("[...document.querySelectorAll('.inbox-decision-row button')].find((b) => b.textContent === 'Approve Once').click()");
  return id;
};
const METRICS = "(() => { const root = document.querySelector('.chat-view'); const send = document.querySelector('#btnSend'); const stop = document.querySelector('#btnStop'); const status = document.querySelector('.chat-status'); const input = document.querySelector('#promptInput'); const feed = document.querySelector('#messageFeed'); const retry = document.querySelector('.chat-retry'); const sr = root ? root.getBoundingClientRect() : null; const ir = input ? input.getBoundingClientRect() : null; return { status: root ? root.dataset.status : null, screen: root ? root.dataset.state : null, label: status ? status.textContent : null, statusRegion: status ? status.getAttribute('role') + '/' + status.getAttribute('aria-live') : null, emptyHint: !!document.querySelector('.chat-empty'), thinking: !!document.querySelector('.chat-thinking'), retryVisible: !!retry, sendVisible: !!send, sendDisabled: send ? send.disabled : null, stopVisible: !!stop, answer: feed ? [...feed.querySelectorAll('.message-assistant .chat-text')].map((e) => e.textContent).join('\\n') : '', userText: feed ? [...feed.querySelectorAll('.message-user .chat-text')].map((e) => e.textContent).join('\\n') : '', errorText: feed ? [...feed.querySelectorAll('.chat-turn-error')].map((e) => e.textContent).join('\\n') : '', noteText: feed ? [...feed.querySelectorAll('.chat-turn-note')].map((e) => e.textContent).join('\\n') : '', inViewport: sr ? (sr.width > 0 && sr.height > 0 && sr.top >= 0 && sr.bottom <= window.innerHeight) : false, inputInViewport: ir ? (ir.width > 0 && ir.top >= 0 && ir.bottom <= window.innerHeight) : false, noOverflow: document.documentElement.scrollWidth <= window.innerWidth }; })()";
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#promptInput') && document.body.classList.contains('is-electron')");
      await js("window.__evts = []; window.opensand.onEvent((e) => { if (window.__evts.length > 200) window.__evts.shift(); window.__evts.push({ t: e.type, s: e.sessionId, d: (e.data ? JSON.stringify(e.data) : '').slice(0, 60) }); }); 'ok'");
      const result = { sizes: {} };
      for (const [w, h, tag] of SIZES) {
        win.setContentSize(w, h);
        await sleep(400);
        const before = await js(METRICS);
        await shot(tag + "-idle");
        await type(PROMPT);
        await wait("!document.querySelector('#btnSend').disabled");
        await js("document.querySelector('#btnSend').click()");
        const seen = [];
        const approvals = [];
        let duringClick = null;
        let thinkingSeen = null;
        let stoppedAt = null;
        let final = null;
        for (let i = 0; i < 600; i++) {
          const m = await js(METRICS);
          if (duringClick === null) duringClick = m;
          if (m.thinking && thinkingSeen === null) thinkingSeen = m;
          if (seen[seen.length - 1] !== m.status) seen.push(m.status);
          if (m.status === "waiting") {
            const id = await approveFromInbox();
            if (id && approvals[approvals.length - 1] !== id) approvals.push(id);
          }
          // The stop case ends the streaming turn the way a person does, then waits for its state.
          if (process.env.OPENSAND_CHAT_STOP_AT_STREAMING === "1" && m.status === "streaming" && stoppedAt === null) {
            await shot(tag + "-streaming");
            await js("(() => { const b = document.querySelector('#btnStop'); if (b) b.click(); })()");
            stoppedAt = m;
          }
          const terminal = stoppedAt ? m.status === "stopped" : (m.status === "done" || m.status === "error");
          if (terminal) { final = m; break; }
          await sleep(100);
        }
        if (!final) {
          const evts = await js("JSON.stringify(window.__evts)");
          throw new Error("turn never finished at " + tag + ": " + JSON.stringify(seen) + " events: " + evts);
        }
        await shot(tag + "-final");
        const evts = await js("JSON.stringify(window.__evts)");
        result.sizes[tag] = { before, seen, final, duringClick, thinkingSeen, approvals, stoppedAt, evts: JSON.parse(evts) };
      }
      console.log("__RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout); app.quit(); process.exit(0);
    } catch (err) {
      console.error("[runner] error", err); clearTimeout(timeout); app.quit(); process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

interface RunOptions {
  endpoint: string;
  model: string;
  sizes: Array<[number, number, string]>;
  stopAtStreaming?: boolean;
  prompt?: string;
}

async function runElectron(home: string, workspace: string, opts: RunOptions): Promise<any> {
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-harness-"));
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER_HEAD, "utf8");
  const env = hermeticElectronEnv(home);
  delete env.OPENSAND_RENDERER;
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_CHAT_SHOT_DIR = shotDir;
  env.OPENSAND_CHAT_SIZES = JSON.stringify(opts.sizes);
  env.OPENSAND_CHAT_PROMPT = opts.prompt || "Summarize the workspace.";
  env.OPENSAND_CHAT_STOP_AT_STREAMING = opts.stopAtStreaming ? "1" : "0";
  env.OPENSAND_ENDPOINT = opts.endpoint;
  env.OPENSAND_MODEL = opts.model;
  env.OPENSAND_API_KEY = "stub-key-not-secret";
  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return whenElectronExited(child);
    });
    assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
    const m = stdout.match(/__RESULT__:(.*)/);
    assert.ok(m, `no result in stdout:\n${stdout}\n${stderr}`);
    return JSON.parse(m[1]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertLayout(tag: string, s: any, isFirst = false) {
  assert.ok(s, `result for ${tag}`);
  // The transcript persists across sizes (the chat state is lifted into the shell),
  // so only the first size sees the idle, empty screen; later sizes see the finished
  // transcript of the previous turn and the same layout guarantees.
  const BUSY = ["sending", "waiting", "streaming"];
  if (isFirst) {
    assert.strictEqual(s.before.status, "idle", `${tag}: the chat starts idle`);
    assert.strictEqual(s.before.screen, "empty", `${tag}: the empty screen shows before the first turn (${s.before.screen})`);
    assert.strictEqual(s.before.emptyHint, true, `${tag}: the empty state explains what the chat does`);
    assert.strictEqual(s.before.label, "Ready.", `${tag}: the status line starts at Ready`);
  } else {
    assert.strictEqual(BUSY.includes(s.before.status), false, `${tag}: the previous turn is no longer busy (${s.before.status})`);
    assert.ok(s.before.userText.includes(PROMPT), `${tag}: the transcript survived the resize`);
  }
  assert.strictEqual(s.before.statusRegion, "status/polite", `${tag}: status text is a polite live region`);
  assert.strictEqual(s.before.inViewport, true, `${tag}: the chat fills the window`);
  assert.strictEqual(s.before.inputInViewport, true, `${tag}: the composer is inside the window`);
  assert.strictEqual(s.before.noOverflow, true, `${tag}: no horizontal overflow`);
  assert.strictEqual(s.before.sendDisabled, true, `${tag}: Send stays disabled with an empty draft`);
  assert.strictEqual(s.duringClick.sendVisible, true, `${tag}: Send is still in the composer`);
  assert.strictEqual(s.duringClick.sendDisabled, true, `${tag}: Send is disabled while the turn runs`);
  assert.strictEqual(s.final.noOverflow, true, `${tag}: no overflow with the answer shown`);
  assert.strictEqual(s.final.inputInViewport, true, `${tag}: the composer stays inside the window`);
}

test("Chat turn streams the model's answer in the real window: 960x740 and full screen", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-chat-home-");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-ws-"));
  const stub = await startStub();
  try {
    const r = await runElectron(home, workspace, { endpoint: stub.endpoint, model: ANSWER_MODEL, sizes: SIZES });
    for (const [i, [, , tag]] of SIZES.entries()) {
      const s = r.sizes[tag];
      assertLayout(tag, s, i === 0);
      assert.strictEqual(s.final.status, "done", `${tag}: the turn finished (${s.final.status}: ${s.final.label})`);
      assert.ok(s.final.userText.includes("Summarize the workspace."), `${tag}: the sent message is in the transcript`);
      assert.ok(s.final.answer.includes(STUB_ANSWER), `${tag}: the transcript shows the model's answer (${JSON.stringify(s.final.answer)})`);
      assert.strictEqual(s.final.screen, "ready", `${tag}: the finished turn is the ready screen (${s.final.screen})`);
      assert.ok(s.seen.includes("streaming"), `${tag}: the answer streamed before it finished (${JSON.stringify(s.seen)})`);
      assert.ok(s.thinkingSeen, `${tag}: the loading state shows Thinking before the first token (${JSON.stringify(s.thinkingSeen)})`);
      assert.ok(s.final.answer.length > 300, `${tag}: the long-message state is covered by a long answer (${s.final.answer.length} chars)`);
      assert.ok(fs.existsSync(path.join(shotDir, `${tag}-final.png`)), `${tag}: finished screenshot written`);
    }
    console.log("chat answer results:", JSON.stringify(Object.fromEntries(Object.entries(r.sizes).map(([k, v]: [string, any]) => [k, { seen: v.seen, status: v.final.status, answer: v.final.answer }]))));
  } finally {
    await stub.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Chat turn shows an error, not a finished answer, when the model is missing", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-chat-home-");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-ws-"));
  const stub = await startStub();
  try {
    const r = await runElectron(home, workspace, { endpoint: stub.endpoint, model: "missing-model", sizes: SIZES });
    for (const [i, [, , tag]] of SIZES.entries()) {
      const s = r.sizes[tag];
      assertLayout(tag, s, i === 0);
      assert.strictEqual(s.final.status, "error", `${tag}: a missing model ends in the error state (${s.final.status})`);
      assert.strictEqual(s.final.screen, "error", `${tag}: the error screen shows (${s.final.screen})`);
      assert.strictEqual(s.final.retryVisible, true, `${tag}: the error screen offers Retry`);
      assert.ok(/not found|model/i.test(s.final.label), `${tag}: the status line names the problem (${JSON.stringify(s.final.label)})`);
      assert.ok(/not found|model/i.test(s.final.errorText), `${tag}: the transcript shows the error (${JSON.stringify(s.final.errorText)})`);
      assert.strictEqual(s.final.answer.includes(STUB_ANSWER), false, `${tag}: no answer text is shown for a failed turn`);
      assert.ok(!/complete|done|finished/i.test(s.final.label), `${tag}: the error state is not reported as done (${JSON.stringify(s.final.label)})`);
      assert.ok(fs.existsSync(path.join(shotDir, `${tag}-final.png`)), `${tag}: error screenshot written`);
    }
    console.log("chat error results:", JSON.stringify(Object.fromEntries(Object.entries(r.sizes).map(([k, v]: [string, any]) => [k, { status: v.final.status, label: v.final.label, error: v.final.errorText }]))));
  } finally {
    await stub.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Chat turn shows the stopped state with the partial answer when Stop is pressed", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-chat-home-");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-ws-"));
  const stub = await startStub();
  try {
    const r = await runElectron(home, workspace, { endpoint: stub.endpoint, model: SLOW_MODEL, sizes: SIZES, stopAtStreaming: true });
    for (const [i, [, , tag]] of SIZES.entries()) {
      const s = r.sizes[tag];
      assertLayout(tag, s, i === 0);
      assert.strictEqual(s.final.status, "stopped", `${tag}: Stop ends the turn as stopped (${s.final.status}: ${s.final.label})`);
      assert.ok(s.final.label?.startsWith("Stopped."), `${tag}: the status line says Stopped (${s.final.label})`);
      assert.strictEqual(s.final.retryVisible, true, `${tag}: a stopped turn offers Retry`);
      assert.strictEqual(s.final.noteText.includes("Stopped."), true, `${tag}: the turn says it was stopped`);
      assert.ok(s.final.answer.includes(PARTIAL_ANSWER), `${tag}: the text received before Stop stays (${JSON.stringify(s.final.answer)})`);
      assert.ok(!s.final.answer.includes("and more."), `${tag}: nothing arrives after Stop`);
      assert.ok(fs.existsSync(path.join(shotDir, `${tag}-streaming.png`)), `${tag}: streaming screenshot written`);
      assert.ok(fs.existsSync(path.join(shotDir, `${tag}-final.png`)), `${tag}: stopped screenshot written`);
    }
    console.log("chat stopped results:", JSON.stringify(Object.fromEntries(Object.entries(r.sizes).map(([k, v]: [string, any]) => [k, { status: v.final.status, answer: v.final.answer, note: v.final.noteText }]))));
  } finally {
    await stub.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
