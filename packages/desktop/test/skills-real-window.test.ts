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

const shotDir = process.env.OPENSAND_SKILLS_SHOT_DIR || "";
// Stay under the desktop-test 120 s ceiling so a stall reports its own logs instead of being
// killed by the suite with no diagnostic.
const TIMEOUT_MS = Number(process.env.OPENSAND_SKILLS_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value, eventName) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event(" + JSON.stringify(eventName) + ", { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value, "input");
const setArea = (sel, value) => nativeSet(sel, "HTMLTextAreaElement", value, "input");

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  // A disposed/throttled frame can leave this promise pending forever, which reads as a hang.
  await js("new Promise((r) => { const done = () => r(true); requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 2000); })");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const q = (s) => document.querySelector(s);\n" +
  "const panel = q('#viewSkills');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewSkills .subnav-tab'));\n" +
  "const grid = q('#skillsCardGrid') ? q('#skillsCardGrid').getBoundingClientRect() : null;\n" +
  "const card = q('#skillsCardGrid .dashboard-card') ? q('#skillsCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const create = q('#createSkillModal');\n" +
  "const preview = q('#skillPreviewModal');\n" +
  "const createOpen = create && !create.classList.contains('hidden');\n" +
  "const previewOpen = preview && !preview.classList.contains('hidden');\n" +
  "const cc = createOpen && create.querySelector('.modal-card') ? create.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const pc = previewOpen && preview.querySelector('.modal-card') ? preview.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const pre = previewOpen && preview.querySelector('.skill-preview-content') ? preview.querySelector('.skill-preview-content').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "gridFits: grid ? (grid.left >= -1 && grid.right <= window.innerWidth + 1) : false,\n" +
    "cardFits: card ? (card.left >= -1 && card.right <= window.innerWidth + 1) : false,\n" +
    "createOpen: Boolean(createOpen),\n" +
    "createCardFits: cc ? (cc.left >= -1 && cc.right <= window.innerWidth + 1 && cc.top >= -1 && cc.bottom <= window.innerHeight + 1) : false,\n" +
    "previewOpen: Boolean(previewOpen),\n" +
    "previewCardFits: pc ? (pc.left >= -1 && pc.right <= window.innerWidth + 1 && pc.top >= -1 && pc.bottom <= window.innerHeight + 1) : false,\n" +
    "previewContentFits: pre ? (pre.left >= -1 && pre.right <= window.innerWidth + 1) : false,\n" +
  "};\n" +
"})()");

const LONG_CONTENT = "---\nname: long-recipe\n---\n# Recipe\n" + "0123456789abcdef".repeat(60);
const result = { emptyState: null, initialCards: null, resetFields: null, validation: null, created: null, preview: null, previewEscClosed: null, remainingCards: null, sizes: { grid: {}, preview: {}, create: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#skillsCardGrid') && document.body.classList.contains('is-electron')");
      // Shared bounded re-dispatch: the hashchange subscriber can mount a tick after the grid.
      await navigateToView({ js, sleep }, "#skills", "#viewSkills");
      await wait("!document.querySelector('#skillsCardGrid .skills-loading')");

      result.emptyState = await js("document.querySelector('#skillsCardGrid .skills-empty') ? document.querySelector('#skillsCardGrid .skills-empty').textContent.trim() : ''");
      result.initialCards = await js("document.querySelectorAll('#skillsCardGrid .dashboard-card').length");
      await shot("skills-empty-960x740");

      // Stub only the skill routes so create/delete are deterministic.
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__skills = [];\n" +
        "window.confirm = () => true;\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (!url.includes('/api/skills')) return orig(input, init);\n" +
          "if (url.endsWith('/api/skills')) {\n" +
            "if (method === 'GET') return json(window.__skills);\n" +
            "if (method === 'POST') {\n" +
              "const body = JSON.parse((init && init.body) || '{}');\n" +
              "if (!body.name || !body.description || !body.content) return json({ error: 'Missing name, description, or content' }, 400);\n" +
              "const skill = { id: 'skill_' + (window.__skills.length + 1), name: body.name, description: body.description, category: 'general', origin: 'custom', content: body.content };\n" +
              "window.__skills = [...window.__skills, skill];\n" +
              "return json(skill, 201);\n" +
            "}\n" +
          "}\n" +
          "if (method === 'DELETE') {\n" +
            "const id = decodeURIComponent(url.split('/').slice(-1)[0]);\n" +
            "window.__skills = window.__skills.filter((s) => s.id !== id);\n" +
            "return json({ success: true });\n" +
          "}\n" +
          "return json([]);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      // Create modal: reset fields then inline validation.
      await js("document.querySelector('#btnOpenCreateSkill').click()");
      await wait("!document.querySelector('#createSkillModal').classList.contains('hidden')");
      result.resetFields = await js("({ name: document.querySelector('#skillName').value, description: document.querySelector('#skillDescription').value, content: document.querySelector('#skillContent').value })");
      await js("document.querySelector('#btnSaveSkill').click()");
      await wait("document.querySelector('#skillsFormError').textContent.includes('Please provide skill name')");
      result.validation = await js("document.querySelector('#skillsFormError').textContent.trim()");
      await shot("skills-validation-960x740");

      // Create a skill with a long single-line recipe.
      await js(setInput('#skillName', 'postgresql-tuning'));
      await js(setInput('#skillDescription', 'Performance query tuning and indexing guidelines'));
      await js(nativeSet('#skillContent', 'HTMLTextAreaElement', LONG_CONTENT, 'input'));
      await js("document.querySelector('#btnSaveSkill').click()");
      await wait("document.querySelectorAll('#skillsCardGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#createSkillModal').classList.contains('hidden')");
      result.created = await js("({ title: document.querySelector('#skillsCardGrid .card-title').textContent.trim(), desc: document.querySelector('#skillsCardGrid .card-desc').textContent.trim(), category: document.querySelector('#skillsCardGrid .card-top .badge')?.textContent.trim(), badges: Array.from(document.querySelectorAll('#skillsCardGrid .card-meta .badge')).map((b) => b.textContent.trim()) })");
      await shot("skills-card-created-960x740");

      // Recipe preview: long single-line content must stay inside the modal.
      await js("document.querySelector('#skillsCardGrid .btn-preview-skill').click()");
      await wait("!document.querySelector('#skillPreviewModal').classList.contains('hidden')");
      result.preview = await js("({ title: document.querySelector('#skillPreviewTitle').textContent.trim(), hasContent: document.querySelector('.skill-preview-content').textContent.includes('0123456789abcdef'), contentScrolls: document.querySelector('.skill-preview-content').scrollWidth <= document.querySelector('.skill-preview-content').clientWidth })");

      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.preview[tag] = await measure();
        await shot("skills-preview-" + tag + "-" + width + "x" + height);
      }
      await js("document.querySelector('#btnCloseSkillPreview').click()");
      await wait("document.querySelector('#skillPreviewModal').classList.contains('hidden')");

      // Esc also closes the preview.
      await js("document.querySelector('#skillsCardGrid .btn-preview-skill').click()");
      await wait("!document.querySelector('#skillPreviewModal').classList.contains('hidden')");
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#skillPreviewModal').classList.contains('hidden')");
      result.previewEscClosed = true;

      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.grid[tag] = await measure();
        await shot("skills-grid-" + tag + "-" + width + "x" + height);
      }

      // Create modal at both sizes, then delete with confirm.
      await js("document.querySelector('#btnOpenCreateSkill').click()");
      await wait("!document.querySelector('#createSkillModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.create[tag] = await measure();
        await shot("skills-create-" + tag + "-" + width + "x" + height);
      }
      await js("document.querySelector('#btnCloseCreateSkill').click()");
      await js("document.querySelector('#skillsCardGrid .btn-del-skill').click()");
      await wait("document.querySelectorAll('#skillsCardGrid .dashboard-card').length === 0");
      result.remainingCards = await js("document.querySelectorAll('#skillsCardGrid .dashboard-card').length");

      console.log("__SKILLS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[skills runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact skills view, creation, preview and deletion at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-skills-home-");
  const ws = makeTempHome("opensand-skills-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Skills Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-skills-harness-"));
  const runner = path.join(tmpDir, "runner-skills.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_SKILLS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-skills-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_SKILLS_SHOT_DIR = proofDir;

  let stdout = "";
  let stderr = "";

  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: ws,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
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
        // Electron helpers inherit the stdio pipes and can outlive the main process, so "close"
        // may never fire. Resolve shortly after "exit" and let stdout drain in the meantime.
        child.on("exit", (c) => setTimeout(() => settle(c ?? 0), 250));
        child.on("close", (c) => settle(c ?? 0));
        child.on("error", (err) => { stderr += String(err); settle(1); });
      });
    });

    assert.strictEqual(code, 0, `skills runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__SKILLS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyState.includes("No modular recipe skills in library."), `empty state renders (${JSON.stringify(res.emptyState)})`);
    assert.strictEqual(res.initialCards, 0, "fresh state has no skill cards");
    assert.deepStrictEqual(res.resetFields, { name: "", description: "", content: "" }, "create modal opens with reset fields");
    assert.strictEqual(res.validation, "Please provide skill name, description and recipe content.", "empty fields are rejected inline");
    assert.ok(res.created.title.includes("postgresql-tuning"), `created card shows the name (${res.created.title})`);
    assert.ok(res.created.desc.includes("Performance query tuning"), "created card shows the description");
    assert.strictEqual(res.created.category, "general", "created card shows the category badge");
    assert.deepStrictEqual(res.created.badges, ["custom", "995 bytes"], "created card shows origin and bytes badges");
    assert.strictEqual(res.preview.title, "postgresql-tuning", "preview shows the skill name as heading");
    assert.strictEqual(res.preview.hasContent, true, "preview shows the recipe content");
    assert.strictEqual(res.preview.contentScrolls, true, "long single-line content wraps instead of widening the modal");
    assert.strictEqual(res.previewEscClosed, true, "Esc closes the preview");
    assert.strictEqual(res.remainingCards, 0, "delete removes the card and refreshes the grid");

    for (const kind of ["grid", "preview", "create"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.tabCount, 4, `${kind} ${tag}: all four Capabilities tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.gridFits, true, `${kind} ${tag}: skills grid fits the window`);
        if (kind === "grid") {
          assert.strictEqual(size.cardFits, true, `${kind} ${tag}: skill card fits the window`);
        } else if (kind === "preview") {
          assert.strictEqual(size.previewOpen, true, `${kind} ${tag}: preview modal is open`);
          assert.strictEqual(size.previewCardFits, true, `${kind} ${tag}: preview card fits the window`);
          assert.strictEqual(size.previewContentFits, true, `${kind} ${tag}: long recipe content fits the window`);
        } else {
          assert.strictEqual(size.createOpen, true, `${kind} ${tag}: create modal is open`);
          assert.strictEqual(size.createCardFits, true, `${kind} ${tag}: create modal card fits the window`);
        }
      }
    }

    console.log("[proof] skills real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
