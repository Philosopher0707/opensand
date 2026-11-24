import { whenElectronExited } from "./helpers/electron-exit.js";
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
import { closeThenRemove } from "./teardown.js";

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

test("desktop-server: routes for agents, tasks, and templates return expected responses", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bots-server-"));
  let server: DesktopServer | undefined;
  try {
    server = new DesktopServer({ baseDir: tmpDir });
    const agentsStore: any[] = [{ id: "agent-cto", name: "CTO", role: "Architect" }];
    const tasksStore: any[] = [{ id: "task-1", title: "Task 1", priority: "medium" }];

    const fakeBridge: any = {
      getAgents: async () => agentsStore,
      createAgent: async (body: any) => {
        const created = { id: "agent-created", ...body };
        agentsStore.push(created);
        return created;
      },
      deleteAgent: async (id: string) => {
        const idx = agentsStore.findIndex((a) => a.id === id);
        if (idx >= 0) agentsStore.splice(idx, 1);
        return true;
      },
      getTasks: async () => tasksStore,
      createTask: async (body: any) => {
        const created = { id: "task-created", ...body };
        tasksStore.push(created);
        return created;
      },
      exportAgentTemplate: async (agentId: string) => {
        return { version: "1.0", agent: { id: agentId, name: "CTO", role: "Architect" } };
      },
      importAgentTemplate: async (body: any) => {
        const imported = { id: "agent-imported", name: body.agent?.name || "Imported", role: body.agent?.role };
        agentsStore.push(imported);
        return imported;
      },
    };
    (server as any).bridge = fakeBridge;
    const authHeaders = {
      authorization: "Bearer " + server.getAuthToken(),
      "content-type": "application/json",
    };

    // 1. GET /api/agents
    {
      const req = new MockIncomingMessage("GET", "/api/agents", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.length, 1);
      assert.strictEqual(data[0].id, "agent-cto");
    }

    // 2. POST /api/agents
    {
      const req = new MockIncomingMessage("POST", "/api/agents", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("data", Buffer.from(JSON.stringify({ name: "QA Bot", role: "QA Engineer" })));
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 201);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.id, "agent-created");
      assert.strictEqual(data.name, "QA Bot");
    }

    // 3. DELETE /api/agents/:id
    {
      const req = new MockIncomingMessage("DELETE", "/api/agents/agent-created", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(res.body), { success: true });
    }

    // 4. GET /api/tasks
    {
      const req = new MockIncomingMessage("GET", "/api/tasks", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.length, 1);
    }

    // 5. POST /api/tasks
    {
      const req = new MockIncomingMessage("POST", "/api/tasks", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("data", Buffer.from(JSON.stringify({ title: "New Task", priority: "urgent" })));
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(JSON.parse(res.body).id, "task-created");
    }

    // 6. GET /api/templates/:agentId
    {
      const req = new MockIncomingMessage("GET", "/api/templates/agent-cto", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.version, "1.0");
      assert.strictEqual(data.agent.id, "agent-cto");
    }

    // 7. POST /api/templates/import
    {
      const req = new MockIncomingMessage("POST", "/api/templates/import", authHeaders);
      const res = new MockServerResponse();
      const p = (server as any).handleRequest(req, res);
      req.emit("data", Buffer.from(JSON.stringify({ version: "1.0", agent: { name: "Imported Bot", role: "Specialist" } })));
      req.emit("end");
      await p;
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(JSON.parse(res.body).id, "agent-imported");
    }
  } finally {
    await closeThenRemove([server], tmpDir);
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

const shotDir = process.env.OPENSAND_BOTS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_BOTS_TIMEOUT_MS || 180000);
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
  "const panel = q('#viewTemplates');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewTemplates .subnav-tab'));\n" +
  "const botList = q('#botList') ? q('#botList').getBoundingClientRect() : null;\n" +
  "const taskList = q('#taskList') ? q('#taskList').getBoundingClientRect() : null;\n" +
  "const grid = q('#templateAgentsGrid') ? q('#templateAgentsGrid').getBoundingClientRect() : null;\n" +
  "const modal = q('#createBotModal');\n" +
  "const modalOpen = modal && !modal.classList.contains('hidden');\n" +
  "const mc = modalOpen && modal.querySelector('.modal-card') ? modal.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "botListFits: botList ? (botList.left >= -1 && botList.right <= window.innerWidth + 1) : false,\n" +
    "taskListFits: taskList ? (taskList.left >= -1 && taskList.right <= window.innerWidth + 1) : false,\n" +
    "gridFits: grid ? (grid.left >= -1 && grid.right <= window.innerWidth + 1) : false,\n" +
    "modalOpen: Boolean(modalOpen),\n" +
    "modalCardFits: mc ? (mc.left >= -1 && mc.right <= window.innerWidth + 1 && mc.top >= -1 && mc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const result = {
  emptyStates: { roster: null, templates: null, tasks: null },
  resetFields: null,
  validation: null,
  escClosed: null,
  createdBot: null,
  createdTask: null,
  exportedTemplate: null,
  importedBot: null,
  deletedBot: null,
  sizes: { grid: {}, modal: {} },
};

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#navBtnBots') && document.body.classList.contains('is-electron')");

      // Set up deterministic mock routes
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__testBots = [];\n" +
        "window.__testTasks = [];\n" +
        "window.alert = () => {};\n" +
        "window.confirm = () => true;\n" +
        "if (window.opensand) {\n" +
          "delete window.opensand.getAgents;\n" +
          "delete window.opensand.createAgent;\n" +
          "delete window.opensand.deleteAgent;\n" +
          "delete window.opensand.getTasks;\n" +
          "delete window.opensand.createTask;\n" +
          "delete window.opensand.exportAgentTemplate;\n" +
          "delete window.opensand.importAgentTemplate;\n" +
        "}\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (url.includes('/api/agents') && method === 'GET') {\n" +
            "return json(window.__testBots);\n" +
          "}\n" +
          "if (url.includes('/api/agents') && method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "if (!body.name || !body.role) return json({ error: 'Please provide bot name and role.' }, 400);\n" +
            "const bot = { id: 'bot_' + (window.__testBots.length + 1), name: body.name, role: body.role, systemPrompt: body.systemPrompt, model: body.model, allowedTools: ['read_file', 'search_web'] };\n" +
            "window.__testBots = [...window.__testBots, bot];\n" +
            "return json(bot, 201);\n" +
          "}\n" +
          "if (url.includes('/api/agents/') && method === 'DELETE') {\n" +
            "const id = decodeURIComponent(url.split('?')[0].split('/').slice(-1)[0]);\n" +
            "window.__testBots = window.__testBots.filter((b) => b.id !== id);\n" +
            "return json({ success: true });\n" +
          "}\n" +
          "if (url.includes('/api/tasks') && method === 'GET') {\n" +
            "return json(window.__testTasks);\n" +
          "}\n" +
          "if (url.includes('/api/tasks') && method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "if (!body.title) return json({ error: 'Please provide a task title.' }, 400);\n" +
            "const task = { id: 'task_' + (window.__testTasks.length + 1), title: body.title, priority: body.priority || 'medium', status: 'pending' };\n" +
            "window.__testTasks = [...window.__testTasks, task];\n" +
            "return json(task, 201);\n" +
          "}\n" +
          "if (url.includes('/api/templates/') && method === 'GET') {\n" +
            "const agentId = decodeURIComponent(url.split('?')[0].split('/').slice(-1)[0]);\n" +
            "const bot = window.__testBots.find((b) => b.id === agentId);\n" +
            "return json({ version: '1.0', agent: bot || { id: agentId, name: 'Exported Bot', role: 'Architect' } });\n" +
          "}\n" +
          "if (url.includes('/api/templates/import') && method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "const agentData = body.agent || body;\n" +
            "const bot = { id: 'bot_' + (window.__testBots.length + 1), name: agentData.name || 'Imported Bot', role: agentData.role || 'Specialist', systemPrompt: agentData.systemPrompt || '', model: agentData.model };\n" +
            "window.__testBots = [...window.__testBots, bot];\n" +
            "return json(bot, 201);\n" +
          "}\n" +
          "return orig(input, init);\n" +
        "};\n" +
        "return true;\n" +
      "})()");

      await navigateToView({ js, sleep }, "#templates", "#viewTemplates");
      await wait("!document.querySelector('#templateAgentsGrid .bots-loading')");

      // 1. Initial empty states
      result.emptyStates.roster = await js("document.querySelectorAll('#botList .bot-item').length");
      result.emptyStates.templates = await js("document.querySelector('#templateAgentsGrid .templates-empty') ? document.querySelector('#templateAgentsGrid .templates-empty').textContent.trim() : ''");
      result.emptyStates.tasks = await js("document.querySelector('#taskList .tasks-empty') ? document.querySelector('#taskList .tasks-empty').textContent.trim() : ''");
      await shot("bots-empty-960x740");

      // 2. Create Bot Modal: open, verify field reset, validation, esc close
      await js("document.querySelector('#btnOpenCreateBot').click()");
      await wait("!document.querySelector('#createBotModal').classList.contains('hidden')");
      result.resetFields = await js("({ name: document.querySelector('#botName').value, role: document.querySelector('#botRole').value, prompt: document.querySelector('#botSystemPrompt').value, model: document.querySelector('#botModel').value })");

      // Save without name/role -> error
      await js("document.querySelector('#btnSaveBot').click()");
      await wait("document.querySelector('#createBotFormError') && document.querySelector('#createBotFormError').textContent.includes('Please provide bot name and role.')");
      result.validation = await js("document.querySelector('#createBotFormError').textContent.trim()");
      await shot("bots-validation-960x740");

      // Escape key closes modal
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#createBotModal').classList.contains('hidden')");
      result.escClosed = true;

      // 3. Create a valid bot persona
      await js("document.querySelector('#btnOpenCreateBot').click()");
      await wait("!document.querySelector('#createBotModal').classList.contains('hidden')");
      await js(setInput('#botName', 'CTO Bot'));
      await js(setInput('#botRole', 'System Architect'));
      await js(setArea('#botSystemPrompt', 'Lead architectural design and system reviews.'));
      await js(setInput('#botModel', 'qwen3:8b'));
      await js("document.querySelector('#btnSaveBot').click()");

      await wait("document.querySelector('#createBotModal').classList.contains('hidden')");
      await wait("document.querySelectorAll('#templateAgentsGrid .agent-template-card').length === 1");
      await wait("document.querySelectorAll('#botList .bot-item').length === 2");

      result.createdBot = await js("({\n" +
        "title: document.querySelector('#templateAgentsGrid .card-title').textContent.trim(),\n" +
        "role: document.querySelector('#templateAgentsGrid .badge-bot').textContent.trim(),\n" +
        "desc: document.querySelector('#templateAgentsGrid .card-desc').textContent.trim(),\n" +
        "rosterName: document.querySelectorAll('#botList .bot-item-name')[1].textContent.trim(),\n" +
      "})");
      await shot("bots-created-960x740");

      // 4. Create a task via Create Task Modal
      await js("document.querySelector('#btnOpenCreateTask').click()");
      await wait("!document.querySelector('#createTaskModal').classList.contains('hidden')");
      await js(setInput('#taskTitle', 'Refactor command runner'));
      await js(setSelect('#taskPriority', 'urgent'));
      await js("document.querySelector('#btnSaveTask').click()");

      await wait("document.querySelector('#createTaskModal').classList.contains('hidden')");
      await wait("document.querySelectorAll('#taskList .task-item').length === 1");

      result.createdTask = await js("({\n" +
        "title: document.querySelector('#taskList .task-title').textContent.trim(),\n" +
        "priority: document.querySelector('#taskList .badge-priority').textContent.trim(),\n" +
      "})");
      await shot("tasks-created-960x740");

      // 5. Export template modal
      await js("document.querySelector('#templateAgentsGrid .btn-export-agent').click()");
      await wait("!document.querySelector('#exportTemplateModal').classList.contains('hidden')");
      await wait("document.querySelector('#exportTemplateJson').textContent.includes('System Architect')");

      result.exportedTemplate = await js("document.querySelector('#exportTemplateJson').textContent.trim()");
      await js("document.querySelector('#btnCopyExportTemplate').click()");
      await js("document.querySelector('#btnCloseExportTemplate').click()");
      await wait("document.querySelector('#exportTemplateModal').classList.contains('hidden')");

      // 6. Import template modal
      await js("document.querySelector('#btnOpenImportTemplate').click()");
      await wait("!document.querySelector('#importTemplateModal').classList.contains('hidden')");
      await js(setArea('#importTemplateJson', JSON.stringify({ version: '1.0', agent: { name: 'QA Specialist', role: 'Release QA' } })));
      await js("document.querySelector('#btnConfirmImportTemplate').click()");

      await wait("document.querySelector('#importTemplateModal').classList.contains('hidden')");
      await wait("document.querySelectorAll('#botList .bot-item').length === 3");
      result.importedBot = await js("document.querySelectorAll('#botList .bot-item-name')[2].textContent.trim()");
      await shot("bots-imported-960x740");

      // 7. Delete bot
      await js("document.querySelectorAll('#botList .btn-delete-bot')[1].click()");
      await wait("document.querySelectorAll('#botList .bot-item').length === 2");
      result.deletedBot = true;

      // 8. Responsive layout measurements across 960x740 and 1920x1080
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("bots-grid-" + tag + "-" + width + "x" + height);
      }

      await js("document.querySelector('#btnOpenCreateBot').click()");
      await wait("!document.querySelector('#createBotModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.modal[tag] = await measure();
        await shot("bots-modal-" + tag + "-" + width + "x" + height);
      }

      console.log("__BOTS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[bots runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact bots & templates view, roster, tasks, and modals at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-bots-home-");
  const ws = makeTempHome("opensand-bots-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Bots Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bots-harness-"));
  const runner = path.join(tmpDir, "runner-bots.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const defaultProof = path.join(os.homedir(), "dev/_scratch/proof-logs/bots");
  const proofDir =
    process.env.OPENSAND_BOTS_SHOT_DIR ||
    (fs.existsSync(path.dirname(defaultProof))
      ? defaultProof
      : fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bots-proofs-")));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_BOTS_SHOT_DIR = proofDir;

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
        let done = false;
        let watchdog: NodeJS.Timeout;
        const settle = (code: number) => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          resolve(code);
        };
        watchdog = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, 180_000);
        void whenElectronExited(child).then(settle);
      });
    });

    assert.strictEqual(code, 0, `bots runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__BOTS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.strictEqual(res.emptyStates.roster, 1); // Default Assistant
    assert.strictEqual(res.emptyStates.templates, "No agents registered. Create an agent persona first.");
    assert.strictEqual(res.emptyStates.tasks, "No workspace tasks recorded yet.");

    assert.deepStrictEqual(res.resetFields, { name: "", role: "", prompt: "", model: "" });
    assert.strictEqual(res.validation, "Please provide bot name and role.");
    assert.strictEqual(res.escClosed, true);

    assert.strictEqual(res.createdBot.title, "CTO Bot");
    assert.strictEqual(res.createdBot.role, "System Architect");
    assert.strictEqual(res.createdBot.desc, "Lead architectural design and system reviews.");
    assert.strictEqual(res.createdBot.rosterName, "CTO Bot");

    assert.strictEqual(res.createdTask.title, "Refactor command runner");
    assert.strictEqual(res.createdTask.priority, "urgent");

    assert.ok(res.exportedTemplate.includes("System Architect"));
    assert.strictEqual(res.importedBot, "QA Specialist");
    assert.strictEqual(res.deletedBot, true);

    for (const kind of ["grid", "modal"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.tabCount, 2, `${kind} ${tag}: both Bots subnav tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.botListFits, true, `${kind} ${tag}: bot list fits window`);
        assert.strictEqual(size.taskListFits, true, `${kind} ${tag}: task list fits window`);
        assert.strictEqual(size.gridFits, true, `${kind} ${tag}: template agents grid fits window`);
        if (kind === "modal") {
          assert.strictEqual(size.modalOpen, true, `${kind} ${tag}: create bot modal is open`);
          assert.strictEqual(size.modalCardFits, true, `${kind} ${tag}: modal card fits window`);
        }
      }
    }

    console.log("[proof] bots real-window screenshots written to:", proofDir);
  } finally {
    await closeThenRemove([], tmpDir, home, ws);
  }
});
