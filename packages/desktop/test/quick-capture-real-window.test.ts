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

// Real Electron window with the Preact shell. Each size is one capture from the topbar button:
// it must show the button, stay inside the window with no horizontal overflow, reach a finished
// state, and clear on Dismiss. 960x740 is the minimum size; 1920x1080 is the full-screen size
// the existing window harness uses. The model is a local stub that answers like Ollama, so a
// finished capture must show the stub's answer text, not only a status line.
const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const shotDir = process.env.OPENSAND_QUICK_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-quick-shots-"));
const SIZES: Array<[number, number, string]> = [[960, 740, "960x740"], [1920, 1080, "full-1920x1080"]];
const STUB_MODEL = "stub-model";
const STUB_MARKER = "STUB ANSWER: Safari, Notes, Terminal";

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

// A local OpenAI-compatible server in the shape llm-client.ts parses: SSE lines with choices[0].delta,
// then [DONE]. On the first request it asks for list_windows; once the tool result is back it answers
// with STUB_MARKER. Any other model name gets a 404 with an Ollama-style error body.
async function startStub(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw || "{}");
      if (body.model !== STUB_MODEL) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `model "${body.model}" not found, try pulling it first` } }));
        return;
      }
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((m: any) => m.role === "tool");
      const chunks = hasToolResult
        ? [
            { delta: { role: "assistant", content: "STUB ANSWER: Safari, " } },
            { delta: { content: "Notes, Terminal" } },
            { delta: {}, finish_reason: "stop" },
          ]
        : [
            { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_stub_1", type: "function", function: { name: "list_windows", arguments: "" } }] } },
            { delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } },
            { delta: {}, finish_reason: "tool_calls" },
          ];
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const choice of chunks) res.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const RUNNER_HEAD = String.raw`
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
const shotDir = process.env.OPENSAND_QUICK_SHOT_DIR || "";
const SIZES = JSON.parse(process.env.OPENSAND_QUICK_SIZES || "[]");
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 150000);
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
// Opens the first Inbox item and clicks Approve Once. Returns the approval id, or "" when none is listed yet.
const approveFromInbox = async () => {
  const id = await js("(() => { const item = document.querySelector('.inbox-item'); if (!item) return ''; if (item.getAttribute('aria-expanded') !== 'true') item.click(); return item.getAttribute('data-approval-id') || ''; })()");
  if (!id) return "";
  await wait("[...document.querySelectorAll('.inbox-decision-row button')].some((b) => b.textContent === 'Approve Once')");
  await js("[...document.querySelectorAll('.inbox-decision-row button')].find((b) => b.textContent === 'Approve Once').click()");
  return id;
};
const METRICS ="(() => { const b = document.querySelector('#btnQuickWindow'); const r = b ? b.getBoundingClientRect() : null; const panel = document.querySelector('.quick-capture'); const label = document.querySelector('.quick-capture-label'); return { exists: !!b, ariaLabel: b ? b.getAttribute('aria-label') : null, disabled: b ? b.disabled : null, inViewport: r ? (r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight) : false, innerWidth: window.innerWidth, innerHeight: window.innerHeight, rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null, scrollWidth: document.documentElement.scrollWidth, noOverflow: document.documentElement.scrollWidth <= window.innerWidth, status: panel ? panel.dataset.status : null, label: label ? label.textContent : null, statusRegion: label ? label.getAttribute('role') + '/' + label.getAttribute('aria-live') : null, textVisible: !!document.querySelector('.quick-capture-text'), answer: document.querySelector('.quick-capture-text') ? document.querySelector('.quick-capture-text').textContent : '' }; })()";
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#btnQuickWindow') && document.body.classList.contains('is-electron')");
      const result = { sizes: {} };
      for (const [w, h, tag] of SIZES) {
        win.setContentSize(w, h);
        await sleep(400);
        const before = await js(METRICS);
        await shot(tag + "-idle");
        await js("document.querySelector('#btnQuickWindow').click()");
        const seen = [];
        const approvals = [];
        let duringClick = null;
        let final = null;
        for (let i = 0; i < 600; i++) {
          const m = await js(METRICS);
          // The first sample is taken right after the click, while the capture is still running.
          if (duringClick === null) duringClick = m;
          if (seen[seen.length - 1] !== m.status) seen.push(m.status);
          if (m.status === "done" || m.status === "error") { final = m; break; }
          // A tool that needs approval pauses the turn; answer it in the Inbox as a person would.
          if (m.status === "waiting") {
            const id = await approveFromInbox();
            if (id && approvals[approvals.length - 1] !== id) approvals.push(id);
          }
          await sleep(100);
        }
        if (!final) {
          const pending = await js("window.opensand.listPendingApprovals().then((a) => JSON.stringify(a), (e) => 'error: ' + e)");
          throw new Error("capture never finished at " + tag + ": " + JSON.stringify(seen) + " pending approvals: " + pending);
        }
        await shot(tag + "-finished");
        result.sizes[tag] = { before, seen, final, duringClick, approvals };
        await js("document.querySelector('.quick-capture-bar .btn').click()");
        await wait("document.querySelector('.quick-capture').dataset.status === 'idle'");
        result.sizes[tag].afterDismiss = await js(METRICS);
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
  shots: string;
  sizes: Array<[number, number, string]>;
}

async function runElectron(home: string, workspace: string, opts: RunOptions): Promise<any> {
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-quick-harness-"));
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER_HEAD, "utf8");
  const env = hermeticElectronEnv(home);
  delete env.OPENSAND_RENDERER;
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_QUICK_SHOT_DIR = opts.shots;
  env.OPENSAND_QUICK_SIZES = JSON.stringify(opts.sizes);
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
      return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
    });
    assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
    const m = stdout.match(/__RESULT__:(.*)/);
    assert.ok(m, `no result in stdout:\n${stdout}\n${stderr}`);
    return JSON.parse(m[1]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertCommon(tag: string, s: any) {
  assert.ok(s, `result for ${tag}`);
  assert.strictEqual(s.before.exists, true, `${tag}: capture button is in the topbar`);
  assert.strictEqual(s.before.ariaLabel, "Capture window", `${tag}: button has its accessible name`);
  assert.strictEqual(s.before.disabled, false, `${tag}: button is enabled when a send channel exists`);
  assert.strictEqual(s.before.inViewport, true, `${tag}: button is fully inside the window (rect ${JSON.stringify(s.before.rect)}, window ${s.before.innerWidth}x${s.before.innerHeight})`);
  assert.strictEqual(s.before.noOverflow, true, `${tag}: no horizontal overflow (${s.before.scrollWidth} > ${s.before.innerWidth})`);
  assert.strictEqual(s.before.status, "idle", `${tag}: panel starts idle`);
  assert.strictEqual(s.before.statusRegion, "status/polite", `${tag}: status text is a polite live region`);
  assert.strictEqual(s.duringClick.disabled, true, `${tag}: button is disabled while the capture runs`);
  assert.ok(s.final.label && s.final.label.length > 0, `${tag}: a finished state has a visible message`);
  assert.strictEqual(s.final.noOverflow, true, `${tag}: no overflow with the result shown`);
  assert.strictEqual(s.final.inViewport, true, `${tag}: panel controls stay inside the window`);
  assert.strictEqual(s.afterDismiss.status, "idle", `${tag}: Dismiss clears the panel`);
  assert.strictEqual(s.afterDismiss.disabled, false, `${tag}: button is enabled again after Dismiss`);
}

test("Quick window capture shows the model's answer in the real Preact window: 960x740 and full screen", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-quick-home-");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-quick-ws-"));
  const stub = await startStub();
  try {
    const r = await runElectron(home, workspace, { endpoint: stub.endpoint, model: STUB_MODEL, shots: shotDir, sizes: SIZES });
    for (const [, , tag] of SIZES) {
      const s = r.sizes[tag];
      assertCommon(tag, s);
      // The folder trust is granted for the workspace on the first capture, so only the first size meets the approval.
      if (tag === "960x740") {
        assert.ok(s.approvals.length >= 1, `${tag}: the folder approval was answered in the Inbox (${JSON.stringify(s.seen)})`);
        assert.ok(s.seen.includes("waiting"), `${tag}: the panel showed the waiting state (${JSON.stringify(s.seen)})`);
      }
      assert.strictEqual(s.final.status, "done", `${tag}: the capture finished with an answer (${s.final.status}: ${s.final.label})`);
      assert.ok(s.final.answer.includes(STUB_MARKER), `${tag}: the panel shows the model's answer (${JSON.stringify(s.final.answer)})`);
      assert.ok(fs.existsSync(path.join(shotDir, `${tag}-finished.png`)), `${tag}: finished screenshot written`);
    }
    console.log("quick-capture results:", JSON.stringify(Object.fromEntries(Object.entries(r.sizes).map(([k, v]: [string, any]) => [k, { seen: v.seen, final: v.final.status, answer: v.final.answer }]))));
  } finally {
    await stub.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Quick window capture shows the error, not an answer, when the model is missing", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-quick-home-");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-quick-ws-"));
  const stub = await startStub();
  try {
    const r = await runElectron(home, workspace, { endpoint: stub.endpoint, model: "missing-model", shots: path.join(shotDir, "error"), sizes: SIZES });
    for (const [, , tag] of SIZES) {
      const s = r.sizes[tag];
      assertCommon(tag, s);
      assert.strictEqual(s.final.status, "error", `${tag}: a missing model ends in the error state (${s.final.status})`);
      assert.ok(s.final.label && /not found|model/i.test(s.final.label), `${tag}: the error names the problem (${JSON.stringify(s.final.label)})`);
      assert.ok(!s.final.answer.includes(STUB_MARKER), `${tag}: no answer is shown for a failed capture`);
    }
  } finally {
    await stub.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
