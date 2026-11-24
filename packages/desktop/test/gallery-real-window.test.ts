import { whenElectronExited } from "./helpers/electron-exit.js";
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

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
const shotDir = process.env.OPENSAND_GALLERY_SHOT_DIR || "";
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 250; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
const setSelect = (sel, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";
const measure = (id) => js("(() => {\n" +
  "const panel = document.querySelector('#" + id + "');\n" +
  "const card = panel && panel.querySelector('.modal-card') ? panel.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const grid = document.querySelector('#galleryCardGrid') ? document.querySelector('#galleryCardGrid').getBoundingClientRect() : null;\n" +
  "const fits = (r) => r ? (r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1) : false;\n" +
  "return { open: panel ? !panel.classList.contains('hidden') : true, scrollWidth: document.documentElement.scrollWidth, noOverflow: document.documentElement.scrollWidth <= window.innerWidth, cardFits: fits(card), gridFits: fits(grid) };\n" +
"})()");
const result = { cards: null, search: null, preview: null, installed: null, publishValidation: null, published: null, escClosed: null, sizes: {} };
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#galleryCardGrid') && document.body.classList.contains('is-electron')");
      await js("(() => {\n" +
        "window.__gallery = [\n" +
          " { id: 'tpl-1', name: 'Code Reviewer', role: 'Reviewer', category: 'engineering', description: 'Reviews diffs', tags: ['review', 'qa'], rating: 4.5, downloads: 1234, author: 'Team', isCurated: true },\n" +
          " { id: 'tpl-2', name: 'Security Auditor', role: 'Auditor', category: 'security', description: 'Audits code', tags: ['security'] }\n" +
        "];\n" +
        "window.__full = { id: 'tpl-1', name: 'Code Reviewer', role: 'Reviewer', model: 'gpt', systemPrompt: 'Review the diff carefully.', allowedTools: ['read', 'grep'], suggestedTasks: ['Review a PR'], metadata: { category: 'engineering', version: '2.1', rating: 4.5, downloads: 1234 } };\n" +
        "window.__agents = [{ id: 'a-1', name: 'My Assistant', role: 'Helper', systemPrompt: 'Help the user.', allowedTools: ['read'], model: 'gpt' }];\n" +
        "window.__installed = false;\n" +
        "window.__published = null;\n" +
        "window.__testGalleryTemplates = function (params) { window.__lastParams = params; if (!params || !params.query) return window.__gallery; return window.__gallery.filter((t) => (t.name || '').toLowerCase().includes(params.query.toLowerCase())); };\n" +
        "window.__testAgents = window.__agents;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/gallery')) return orig(input, init);\n" +
          "if (url.includes('/publish')) { const body = JSON.parse((init && init.body) || '{}'); window.__published = body; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }\n" +
          "if (url.includes('/install')) { window.__installed = true; return new Response(JSON.stringify({ agent: { id: 'new' } }), { status: 200 }); }\n" +
          "if (method === 'GET' && url.includes('/templates/')) return new Response(JSON.stringify(window.__full), { status: 200 });\n" +
          "if (method === 'GET') return new Response(JSON.stringify(window.__gallery), { status: 200 });\n" +
          "return new Response(JSON.stringify([]), { status: 200 });\n" +
        "};\n" +
        "return true;\n" +
      "})()");
      await js("document.querySelector('#btnRefreshGallery').click()");
      await wait("document.querySelectorAll('#galleryCardGrid .gallery-template-card').length === 2");
      result.cards = await js("Array.from(document.querySelectorAll('#galleryCardGrid .gallery-card-title')).map((e) => e.textContent.trim())");
      await js(nativeSet('#gallerySearchInput', 'reviewer'));
      await sleep(500);
      result.search = await js("({ query: window.__lastParams && window.__lastParams.query, titles: Array.from(document.querySelectorAll('#galleryCardGrid .gallery-card-title')).map((e) => e.textContent.trim()) })");
      if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(path.join(shotDir, "gallery-grid-960x740.png"), (await win.webContents.capturePage()).toPNG()); }

      await js("document.querySelector('#galleryCardGrid .btn-preview-tpl').click()");
      await wait("!document.querySelector('#templatePreviewModal').classList.contains('hidden')");
      await wait("document.querySelector('#previewModalPrompt') && document.querySelector('#previewModalPrompt').textContent.includes('Review the diff')");
      result.preview = await js("({ title: document.querySelector('#previewModalTitle').textContent.trim(), badges: Array.from(document.querySelectorAll('#previewModalMeta .badge')).map((b) => b.textContent.trim()), tools: Array.from(document.querySelectorAll('#previewModalTools .badge')).map((b) => b.textContent.trim()) })");
      await js("document.querySelector('#btnInstallFromPreview').click()");
      await wait("Boolean(window.__installed)");
      result.installed = await js("window.__installed");
      await sleep(300);
      await js("document.querySelector('#btnClosePreviewModal').click()");
      await wait("document.querySelector('#templatePreviewModal').classList.contains('hidden')");

      await js("document.querySelector('#btnOpenPublishTemplate').click()");
      await wait("!document.querySelector('#publishTemplateModal').classList.contains('hidden')");
      await sleep(300);
      await js("document.querySelector('#btnSubmitPublish').click()");
      await wait("document.querySelector('#publishTemplateModal .gallery-error')");
      result.publishValidation = await js("document.querySelector('#publishTemplateModal .gallery-error').textContent.trim()");
      await js(setSelect('#publishAgentSelect', 'a-1'));
      await js(setSelect('#publishCategory', 'security'));
      await js(nativeSet('#publishTags', 'Testing, Fast-API'));
      await js("document.querySelector('#btnSubmitPublish').click()");
      await wait("Boolean(window.__published)");
      result.published = await js("window.__published");

      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes[tag] = { grid: await measure('galleryCardGrid') };
        if (shotDir) fs.writeFileSync(path.join(shotDir, "gallery-" + tag + "-" + width + "x" + height + ".png"), (await win.webContents.capturePage()).toPNG());
      }
      await js("document.querySelector('#btnOpenPublishTemplate').click()");
      await sleep(300);
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#publishTemplateModal').classList.contains('hidden')");
      result.escClosed = true;

      console.log("__GALLERY_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[gallery runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact community gallery search, preview, install and publish at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) { t.skip(reason); return; }
  const home = makeTempHome("opensand-gallery-home-");
  const ws = makeTempHome("opensand-gallery-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Gallery Real Window Test Workspace\n", "utf8");
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-harness-"));
  const runner = path.join(tmpDir, "runner-gallery.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_GALLERY_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });
  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_GALLERY_SHOT_DIR = proofDir;
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
    assert.strictEqual(code, 0, `gallery runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__GALLERY_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);
    assert.deepStrictEqual(res.cards, ["Code Reviewer", "Security Auditor"], "gallery cards render");
    assert.deepStrictEqual(res.search, { query: "reviewer", titles: ["Code Reviewer"] }, "debounced search reaches the data layer");
    assert.strictEqual(res.preview.title, "Code Reviewer", "preview title renders");
    assert.ok(res.preview.badges.includes("v2.1"), "preview metadata renders");
    assert.deepStrictEqual(res.preview.tools, ["read", "grep"], "preview tools render");
    assert.strictEqual(res.installed, true, "install action reaches the data layer");
    assert.strictEqual(res.publishValidation, "Please select an agent persona to publish.", "publish requires an agent");
    assert.strictEqual(res.published.id, "my-assistant", "published slug is derived from the agent name");
    assert.strictEqual(res.published.category, "security", "published category is sent");
    assert.deepStrictEqual(res.published.tags, ["testing", "fast-api"], "published tags are parsed");
    assert.strictEqual(res.escClosed, true, "Esc closes the publish modal");
    for (const tag of ["compact", "wide"]) {
      const m = res.sizes[tag].grid;
      assert.strictEqual(m.open, true, `${tag} gallery visible`);
      assert.strictEqual(m.noOverflow, true, `${tag} no overflow`);
      assert.strictEqual(m.gridFits, true, `${tag} grid fits`);
    }
    console.log("gallery real-window: grid/search/preview/install/publish states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
