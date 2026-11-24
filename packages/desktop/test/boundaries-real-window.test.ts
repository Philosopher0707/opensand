import { whenElectronExited } from "./helpers/electron-exit.js";
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NAV_HELPER_URL = pathToFileURL(path.join(pkgRoot, "dist/test/helpers/navigate-view.js")).href;

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

const shotDir = process.env.OPENSAND_BOUNDARIES_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_BOUNDARIES_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");
const setSelect = (sel, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => { const done = () => r(true); requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 2000); })");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const panel = document.querySelector('#viewBoundaries');\n" +
  "const grid = document.querySelector('#boundariesCardGrid') ? document.querySelector('#boundariesCardGrid').getBoundingClientRect() : null;\n" +
  "const feed = document.querySelector('#boundariesAuditFeed') ? document.querySelector('#boundariesAuditFeed').getBoundingClientRect() : null;\n" +
  "const card = document.querySelector('#boundariesCardGrid .dashboard-card') ? document.querySelector('#boundariesCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const item = document.querySelector('#boundariesAuditFeed .boundary-item') ? document.querySelector('#boundariesAuditFeed .boundary-item').getBoundingClientRect() : null;\n" +
  "const create = document.querySelector('#createRuleModal');\n" +
  "const createOpen = create && !create.classList.contains('hidden');\n" +
  "const cc = createOpen && create.querySelector('.modal-card') ? create.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const fits = (r) => r ? (r.left >= -1 && r.right <= window.innerWidth + 1) : false;\n" +
  "return {\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "panelVisible: panel ? !panel.classList.contains('hidden') : false,\n" +
    "gridFits: fits(grid), feedFits: fits(feed), cardFits: fits(card), itemFits: fits(item),\n" +
    "createOpen: Boolean(createOpen),\n" +
    "createCardFits: cc ? (fits(cc) && cc.top >= -1 && cc.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const LONG_ARGS = "argument ".repeat(80);
const result = { emptyRules: null, emptyAudit: null, resetFields: null, validation: null, created: null, audit: null, remaining: null, escClosed: null, sizes: { grid: {}, audit: {}, create: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#boundariesCardGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#boundaries", "#viewBoundaries");
      await wait("document.querySelector('#boundariesCardGrid .boundaries-empty') || document.querySelector('#boundariesCardGrid .dashboard-card')");

      // Force empty states through the same data hook a real empty deployment would see.
      await js("window.__testPolicies = []; window.__testPolicyAudit = []");
      await js("document.querySelector('#btnRefreshBoundaries') ? document.querySelector('#btnRefreshBoundaries').click() : location.reload()");
      await wait("document.querySelector('#boundariesCardGrid .boundaries-empty')");
      result.emptyRules = await js("document.querySelector('#boundariesCardGrid .boundaries-empty').textContent.trim()");
      result.emptyAudit = await js("document.querySelector('#boundariesAuditFeed .boundaries-empty') ? document.querySelector('#boundariesAuditFeed .boundaries-empty').textContent.trim() : ''");
      await shot("boundaries-empty-960x740");

      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__policies = [];\n" +
        "window.__audit = [\n" +
          " { decision: 'DENIED', toolName: 'shell', ruleName: 'no push', reason: 'blocked by policy', argsSummary: '" + LONG_ARGS + "', timestamp: 1700000000000 },\n" +
          " { decision: 'REQUIRE_APPROVAL', toolName: 'write_file', reason: 'needs a human', timestamp: 1700000000001 },\n" +
          " { decision: 'ALLOWED', toolName: 'read_file', reason: 'read is safe', timestamp: 1700000000002 }\n" +
        "];\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/policies')) return orig(input, init);\n" +
          "if (url.includes('/api/policies/audit')) return json(window.__audit);\n" +
          "if (method === 'GET') return json(window.__policies);\n" +
          "if (method === 'POST') {\n" +
            "const body = JSON.parse((init && init.body) || '{}');\n" +
            "if (!body.name || !body.name.trim()) return json({ error: 'Please specify a rule name.' }, 400);\n" +
            "const rule = { id: body.id, name: body.name, action: body.action, tools: body.tools, commandRegex: body.commandRegex, pathsPrefix: body.pathsPrefix, description: body.description };\n" +
            "window.__policies.push(rule);\n" +
            "return json(rule, 201);\n" +
          "}\n" +
          "if (method === 'DELETE') {\n" +
            "const id = decodeURIComponent(url.split('/').slice(-1)[0]);\n" +
            "const i = window.__policies.findIndex((p) => p.id === id); if (i >= 0) window.__policies.splice(i, 1);\n" +
            "return json({ success: true });\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      await js("(() => { window.__testPolicies = window.__policies; window.__testPolicyAudit = window.__audit; window.confirm = () => true; window.__createCalls = 0; window.opensand.createPolicy = async (rule) => { window.__createCalls++; window.__policies.push(rule); return rule; }; window.opensand.deletePolicy = async (id) => { const i = window.__policies.findIndex((p) => p.id === id); if (i >= 0) window.__policies.splice(i, 1); return { success: true }; }; return true; })()");
      await js("document.querySelector('#btnRefreshBoundaries').click()");
      await wait("document.querySelectorAll('#boundariesAuditFeed .boundary-item').length === 3");
      await js("document.querySelector('#btnOpenCreateRule').click()");
      await wait("!document.querySelector('#createRuleModal').classList.contains('hidden')");
      result.resetFields = await js("({ name: document.querySelector('#ruleName').value, action: document.querySelector('#ruleAction').value, tool: document.querySelector('#ruleTool').value, regex: document.querySelector('#ruleCommandRegex').value, path: document.querySelector('#rulePathPrefix').value, desc: document.querySelector('#ruleDesc').value })");
      await js("document.querySelector('#btnSaveRule').click()");
      await wait("document.querySelector('#ruleFormError').textContent.includes('Please specify a rule name')");
      result.validation = await js("document.querySelector('#ruleFormError').textContent.trim()");
      await shot("boundaries-validation-960x740");

      await js(setInput('#ruleName', 'no push to main'));
      await js(setSelect('#ruleAction', 'DENY'));
      await js(setInput('#ruleTool', 'shell, exec,  git'));
      await js(setInput('#ruleCommandRegex', 'git push .*main'));
      await js(setInput('#rulePathPrefix', '/Users/me/dev, /etc'));
      await js(setInput('#ruleDesc', 'Blocks direct pushes'));
      await js("document.querySelector('#btnSaveRule').click()");
      await wait("document.querySelectorAll('#boundariesCardGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#createRuleModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#boundariesCardGrid .card-title').textContent.trim(), action: document.querySelector('#boundariesCardGrid .card-top .badge').textContent.trim(), badges: Array.from(document.querySelectorAll('#boundariesCardGrid .card-meta .badge')).map((b) => b.textContent.trim()) })");
      await shot("boundaries-card-created-960x740");

      // Long argsSummary must stay inside the feed.
      result.audit = await js("({ decisions: Array.from(document.querySelectorAll('#boundariesAuditFeed .status-badge')).map((e) => e.textContent.trim()), reasons: Array.from(document.querySelectorAll('#boundariesAuditFeed .boundary-reason')).map((e) => e.textContent.trim()) })");
      await shot("boundaries-audit-960x740");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        result.sizes.audit[tag] = await measure();
        await shot("boundaries-audit-" + tag + "-" + width + "x" + height);
      }

      await js("document.querySelector('#btnOpenCreateRule').click()");
      await wait("!document.querySelector('#createRuleModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.create[tag] = await measure();
        await shot("boundaries-create-" + tag + "-" + width + "x" + height);
      }
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#createRuleModal').classList.contains('hidden')");
      result.escClosed = true;

      await js("document.querySelector('#boundariesCardGrid .btn-delete-rule').click()");
      await wait("document.querySelectorAll('#boundariesCardGrid .dashboard-card').length === 0");
      result.remaining = await js("document.querySelectorAll('#boundariesCardGrid .dashboard-card').length");

      console.log("__BOUNDARIES_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[boundaries runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact boundaries view, rule creation, audit and deletion at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const home = makeTempHome("opensand-boundaries-home-");
  const ws = makeTempHome("opensand-boundaries-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Boundaries Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-boundaries-harness-"));
  const runner = path.join(tmpDir, "runner-boundaries.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_BOUNDARIES_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-boundaries-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_BOUNDARIES_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => {
        let done = false;
        let watchdog: NodeJS.Timeout;
        const settle = (code: number) => { if (done) return; done = true; clearTimeout(watchdog); resolve(code); };
        watchdog = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, 180_000);
        void whenElectronExited(child).then(settle);
        child.on("error", (err) => { stderr += String(err); settle(1); });
      });
    });
    assert.strictEqual(code, 0, `boundaries runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__BOUNDARIES_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyRules.includes("No boundary policy rules"), `empty grid renders (${res.emptyRules})`);
    assert.ok(res.emptyAudit.includes("No policy evaluations"), `empty audit renders (${res.emptyAudit})`);
    assert.deepStrictEqual(res.resetFields, { name: "", action: "DENY", tool: "", regex: "", path: "", desc: "" }, "modal opens with reset fields");
    assert.strictEqual(res.validation, "Please specify a rule name.", "empty name is rejected inline");
    assert.ok(res.created.title.includes("no push to main"), `created card shows the name (${res.created.title})`);
    assert.strictEqual(res.created.action, "DENY", "created card shows the action badge");
    assert.deepStrictEqual(res.created.badges, ["Tools: shell, exec, git", "Regex: git push .*main", "Paths: /Users/me/dev, /etc"], "created card shows parsed fields");
    assert.deepStrictEqual(res.audit.decisions, ["ALLOWED", "REQUIRE_APPROVAL", "DENIED"], "audit decisions render newest first");
    assert.deepStrictEqual(res.audit.reasons, ["read is safe", "needs a human", "blocked by policy"], "audit reasons render newest first");
    assert.strictEqual(res.escClosed, true, "Esc closes the create modal");
    assert.strictEqual(res.remaining, 0, "delete removes the rule card");

    for (const tag of ["compact", "wide"]) {
      for (const group of [res.sizes.grid, res.sizes.audit, res.sizes.create]) {
        const m = group[tag];
        assert.strictEqual(m.panelVisible, true, `${tag} panel visible`);
        assert.strictEqual(m.noOverflow, true, `${tag} has no horizontal overflow`);
        assert.strictEqual(m.gridFits, true, `${tag} grid fits`);
        assert.strictEqual(m.feedFits, true, `${tag} audit feed fits`);
      }
      assert.strictEqual(res.sizes.create[tag].createOpen, true, `${tag} create modal open`);
      assert.strictEqual(res.sizes.create[tag].createCardFits, true, `${tag} create modal card fits`);
    }
    console.log("boundaries real-window: empty/validation/create/audit/delete states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
