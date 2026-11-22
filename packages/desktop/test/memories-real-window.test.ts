import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";
import { DesktopServer } from "../src/desktop-server.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NAV_HELPER_URL = pathToFileURL(path.join(pkgRoot, "dist/test/helpers/navigate-view.js")).href;

// Mock classes for DesktopServer testing
class MockIncomingMessage extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string>;
  public socket: any;

  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: "127.0.0.1:3456", ...headers };
    this.socket = { remoteAddress: "127.0.0.1" };
  }

  public destroy(): this {
    this.emit("close");
    return this;
  }
}

class MockServerResponse extends EventEmitter {
  public statusCode: number = 200;
  public headers: Record<string, string> = {};
  public body: string = "";

  public setHeader(key: string, val: string) {
    this.headers[key.toLowerCase()] = val;
  }

  public writeHead(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  }

  public write(chunk: string | Buffer) {
    this.body += chunk.toString();
  }

  public end(chunk?: string | Buffer) {
    if (chunk) {
      this.body += chunk.toString();
    }
    this.emit("finish");
  }
}

test("memories: approve sends POST /api/team-review/resolve with {itemId, decision:approve} through real handler", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-memories-handler-"));
  try {
    const server = new DesktopServer({ baseDir: tmpDir });
    let resolvedCall: { itemId: string; decision: string; reviewerId?: string } | null = null;
    const fakeBridge: any = {
      resolveReviewItem: async (itemId: string, decision: string, reviewerId?: string) => {
        resolvedCall = { itemId, decision, reviewerId };
        return { id: itemId, status: "resolved", decision };
      },
    };
    (server as any).bridge = fakeBridge;

    const req = new MockIncomingMessage("POST", "/api/team-review/resolve", {
      authorization: "Bearer " + server.getAuthToken(),
      "content-type": "application/json",
    });
    const res = new MockServerResponse();
    const handlePromise = (server as any).handleRequest(req, res);
    req.emit("data", Buffer.from(JSON.stringify({ itemId: "item-101", decision: "approve" })));
    req.emit("end");
    await handlePromise;

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body, { id: "item-101", status: "resolved", decision: "approve" });
    assert.deepStrictEqual(resolvedCall, { itemId: "item-101", decision: "approve", reviewerId: undefined });

    // Missing decision returns 400
    const reqBad = new MockIncomingMessage("POST", "/api/team-review/resolve", {
      authorization: "Bearer " + server.getAuthToken(),
      "content-type": "application/json",
    });
    const resBad = new MockServerResponse();
    const badPromise = (server as any).handleRequest(reqBad, resBad);
    reqBad.emit("data", Buffer.from(JSON.stringify({ itemId: "item-101" })));
    reqBad.emit("end");
    await badPromise;
    assert.strictEqual(resBad.statusCode, 400);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

const RUNNER_SCRIPT = String.raw`
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { navigateToView } from "${NAV_HELPER_URL}";

const shotDir = process.env.OPENSAND_MEMORIES_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_MEMORIES_TIMEOUT_MS || 180000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");
const setArea = (sel, value) => nativeSet(sel, "HTMLTextAreaElement", value, "input");
const setSelect = (sel, value) => nativeSet(sel, "HTMLSelectElement", value, "change");

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const q = (s) => document.querySelector(s);\n" +
  "const panel = q('#viewMemories');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewMemories .subnav-tab'));\n" +
  "const revGrid = q('#teamReviewGrid') ? q('#teamReviewGrid').getBoundingClientRect() : null;\n" +
  "const memGrid = q('#memoriesGrid') ? q('#memoriesGrid').getBoundingClientRect() : null;\n" +
  "const modal = q('#addMemoryModal');\n" +
  "const modalOpen = modal && !modal.classList.contains('hidden');\n" +
  "const mc = modalOpen && modal.querySelector('.modal-card') ? modal.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "revGridFits: revGrid ? (revGrid.left >= -1 && revGrid.right <= window.innerWidth + 1) : false,\n" +
    "memGridFits: memGrid ? (memGrid.left >= -1 && memGrid.right <= window.innerWidth + 1) : false,\n" +
    "modalOpen: Boolean(modalOpen),\n" +
    "modalCardFits: mc ? (mc.left >= -1 && mc.right <= window.innerWidth + 1 && mc.top >= -1 && mc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const result = {
  emptyStates: { review: null, memories: null },
  resetFields: null,
  validation: null,
  escClosed: null,
  createdFact: null,
  reviewApproved: null,
  forgotten: null,
  sizes: { grid: {}, modal: {} },
};

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#skillsCardGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#memories", "#viewMemories");
      await wait("!document.querySelector('#memoriesGrid .memories-loading')");

      // 1. Initial empty states
      result.emptyStates.review = await js("document.querySelector('#teamReviewGrid .memories-empty') ? document.querySelector('#teamReviewGrid .memories-empty').textContent.trim() : ''");
      result.emptyStates.memories = await js("document.querySelector('#memoriesGrid .memories-empty') ? document.querySelector('#memoriesGrid .memories-empty').textContent.trim() : ''");
      await shot("memories-empty-960x740");

      // 2. Deterministic route stubs
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__memories = [];\n" +
        "window.__reviewItems = [];\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (url.includes('/api/team-review/resolve') && method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "window.__reviewItems = window.__reviewItems.filter((r) => r.id !== body.itemId);\n" +
            "return json({ success: true, itemId: body.itemId, decision: body.decision });\n" +
          "}\n" +
          "if (url.includes('/api/team-review') && method === 'GET') {\n" +
            "return json(window.__reviewItems);\n" +
          "}\n" +
          "if (url.includes('/api/memories') && method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "if (!body.text) return json({ error: 'Please provide memory text.' }, 400);\n" +
            "const fact = { id: 'mem_' + (window.__memories.length + 1), text: body.text, scope: body.scope, tier: body.tier, confidence: 1, updatedAtMs: Date.now() };\n" +
            "window.__memories = [...window.__memories, fact];\n" +
            "return json(fact, 201);\n" +
          "}\n" +
          "if (url.includes('/api/memories') && method === 'DELETE') {\n" +
            "const id = decodeURIComponent(url.split('?')[0].split('/').slice(-1)[0]);\n" +
            "window.__memories = window.__memories.filter((m) => m.id !== id);\n" +
            "return json({ success: true });\n" +
          "}\n" +
          "if (url.includes('/api/memories') && method === 'GET') {\n" +
            "return json(window.__memories);\n" +
          "}\n" +
          "return orig(input, init);\n" +
        "};\n" +
        "return true;\n" +
      "})()");

      // 3. Add memory modal: reset fields then inline validation
      await js("document.querySelector('#btnOpenAddMemory').click()");
      await wait("!document.querySelector('#addMemoryModal').classList.contains('hidden')");
      result.resetFields = await js("({ text: document.querySelector('#memText').value, scope: document.querySelector('#memScope').value, tier: document.querySelector('#memTier').value })");

      // Click save with empty text -> validation error
      await js("document.querySelector('#btnSaveMemory').click()");
      await wait("document.querySelector('#memoriesFormError').textContent.includes('Please provide memory text.')");
      result.validation = await js("document.querySelector('#memoriesFormError').textContent.trim()");
      await shot("memories-validation-960x740");

      // Esc closes the modal
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#addMemoryModal').classList.contains('hidden')");
      result.escClosed = true;

      // 4. Inject a review item and add a memory fact
      await js("(() => {\n" +
        "window.__reviewItems = [{\n" +
          "id: 'rev-test-1',\n" +
          "action: 'promote',\n" +
          "status: 'pending',\n" +
          "proposedByAgentId: 'agent-scout',\n" +
          "proposedFact: { text: 'Strict TypeScript guidelines for all packages', tier: 'rule' }\n" +
        "}];\n" +
        "return true;\n" +
      "})()");

      await js("document.querySelector('#btnOpenAddMemory').click()");
      await wait("!document.querySelector('#addMemoryModal').classList.contains('hidden')");
      await js(setArea('#memText', 'Always format commit messages with conventional commits'));
      await js(setSelect('#memScope', 'team'));
      await js(setSelect('#memTier', 'guideline'));
      await js("document.querySelector('#btnSaveMemory').click()");

      // Saving triggers reload() which fetches both memories and review items
      await wait("document.querySelectorAll('#memoriesGrid .dashboard-card').length === 1");
      await wait("document.querySelectorAll('#teamReviewGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#addMemoryModal').classList.contains('hidden')");

      result.createdFact = await js("({ title: document.querySelector('#memoriesGrid .card-title').textContent.trim(), scope: document.querySelector('#memoriesGrid .badge-bot').textContent.trim(), text: document.querySelector('#memoriesGrid .card-desc').textContent.trim() })");
      await shot("memories-card-created-960x740");

      // 5. Team Review Queue: Approve proposal
      const revTitle = await js("document.querySelector('#teamReviewGrid .card-title').textContent.trim()");
      await js("document.querySelector('#teamReviewGrid .btn-approve-rev').click()");
      await wait("document.querySelectorAll('#teamReviewGrid .dashboard-card').length === 0");
      const revEmptyAfter = await js("document.querySelector('#teamReviewGrid .memories-empty').textContent.trim()");
      result.reviewApproved = { title: revTitle, emptyAfter: revEmptyAfter };

      // 6. Forget memory fact
      await js("document.querySelector('#memoriesGrid .btn-forget-mem').click()");
      await wait("document.querySelectorAll('#memoriesGrid .dashboard-card').length === 0");
      result.forgotten = await js("document.querySelector('#memoriesGrid .memories-empty').textContent.trim()");

      // 7. Responsive checks across both sizes
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("memories-grid-" + tag + "-" + width + "x" + height);
      }

      await js("document.querySelector('#btnOpenAddMemory').click()");
      await wait("!document.querySelector('#addMemoryModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.modal[tag] = await measure();
        await shot("memories-modal-" + tag + "-" + width + "x" + height);
      }

      console.log("__MEMORIES_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[memories runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact memories view, team review queue and creation at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-memories-home-");
  const ws = makeTempHome("opensand-memories-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Memories Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-memories-harness-"));
  const runner = path.join(tmpDir, "runner-memories.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const defaultProof = path.join(os.homedir(), "dev/_scratch/proof-logs/memories");
  const proofDir =
    process.env.OPENSAND_MEMORIES_SHOT_DIR ||
    (fs.existsSync(path.dirname(defaultProof))
      ? defaultProof
      : fs.mkdtempSync(path.join(os.tmpdir(), "opensand-memories-proofs-")));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_MEMORIES_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";

  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        stderr += String(err);
      });
      return new Promise<number>((resolve) => {
        const watchdog = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(124);
        }, 180_000);
        child.on("close", (c) => {
          clearTimeout(watchdog);
          resolve(c ?? 0);
        });
      });
    });

    assert.strictEqual(code, 0, `memories runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__MEMORIES_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.strictEqual(res.emptyStates.review, "No pending team memory review proposals.");
    assert.strictEqual(res.emptyStates.memories, "No memory facts recorded yet.");
    assert.deepStrictEqual(res.resetFields, { text: "", scope: "user", tier: "preference" });
    assert.strictEqual(res.validation, "Please provide memory text.");
    assert.strictEqual(res.escClosed, true);
    assert.strictEqual(res.createdFact.title, "GUIDELINE");
    assert.strictEqual(res.createdFact.scope, "team");
    assert.strictEqual(res.createdFact.text, "Always format commit messages with conventional commits");
    assert.ok(res.reviewApproved.title.includes("promote: Strict TypeScript guidelines for all pac..."));
    assert.strictEqual(res.reviewApproved.emptyAfter, "No pending team memory review proposals.");
    assert.strictEqual(res.forgotten, "No memory facts recorded yet.");

    for (const kind of ["grid", "modal"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.tabCount, 4, `${kind} ${tag}: all four Capabilities tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.revGridFits, true, `${kind} ${tag}: review grid fits the window`);
        assert.strictEqual(size.memGridFits, true, `${kind} ${tag}: memories grid fits the window`);
        if (kind === "modal") {
          assert.strictEqual(size.modalOpen, true, `${kind} ${tag}: add memory modal is open`);
          assert.strictEqual(size.modalCardFits, true, `${kind} ${tag}: modal card fits the window`);
        }
      }
    }

    console.log("[proof] memories real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
