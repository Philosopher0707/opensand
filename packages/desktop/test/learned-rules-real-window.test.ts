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
const shotDir = process.env.OPENSAND_LEARNED_SHOT_DIR || "";
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const measure = () => js("(() => {\n" +
  "const panel = document.querySelector('#learnedRulesModal');\n" +
  "const card = panel && panel.querySelector('.modal-card') ? panel.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "const pre = document.querySelector('#learnedRulesContent') ? document.querySelector('#learnedRulesContent').getBoundingClientRect() : null;\n" +
  "const fits = (r) => r ? (r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1) : false;\n" +
  "return { open: panel ? !panel.classList.contains('hidden') : false, scrollWidth: document.documentElement.scrollWidth, noOverflow: document.documentElement.scrollWidth <= window.innerWidth, cardFits: fits(card), contentFits: fits(pre) };\n" +
"})()");
const result = { content: null, refreshing: null, summary: null, error: null, closed: null, sizes: {} };
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#btnMenuToggleTheme') && document.body.classList.contains('is-electron')");
      await js("(() => {\n" +
        "window.__testLearnedRules = { content: 'Always use pnpm.\\nVerify with tests.' };\n" +
        "window.__report = { markdownSummary: '# Analysis\\nNo new rules.' };\n" +
        "window.opensand.refreshLearnedRules = async () => { await new Promise(function(r){ setTimeout(r, 300); }); return window.__report; };\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "if (!url.includes('/api/learned-rules')) return orig(input, init);\n" +
          "if (url.includes('/refresh')) { await new Promise(function(r){ setTimeout(r, 300); }); return new Response(JSON.stringify(window.__report), { status: 200 }); }\n" +
          "return new Response(JSON.stringify(window.__testLearnedRules), { status: 200 });\n" +
        "};\n" +
        "return true;\n" +
      "})()");
      await js("document.querySelector('#accountMenuTrigger').click()");
      await wait("!document.querySelector('#accountPopup').classList.contains('hidden')");
      await js("document.querySelector('#btnMenuLearnedRules').click()");
      await wait("!document.querySelector('#learnedRulesModal').classList.contains('hidden')");
      await wait("document.querySelector('#learnedRulesContent').textContent.includes('Always use pnpm')");
      result.content = await js("document.querySelector('#learnedRulesContent').textContent.trim()");
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        fs.writeFileSync(path.join(shotDir, "learned-rules-960x740.png"), (await win.webContents.capturePage()).toPNG());
      }

      await js("document.querySelector('#btnRefreshLearnedRules').click()");
      await wait("document.querySelector('#learnedRulesContent').textContent.includes('Re-analyzing')");
      result.refreshing = true;
      await wait("document.querySelector('#learnedRulesContent').textContent.includes('No new rules')");
      result.summary = await js("document.querySelector('#learnedRulesContent').textContent.trim()");
      result.error = await js("document.querySelector('.learned-rules-error') ? document.querySelector('.learned-rules-error').textContent.trim() : ''");

      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes[tag] = await measure();
        if (shotDir) fs.writeFileSync(path.join(shotDir, "learned-rules-" + tag + "-" + width + "x" + height + ".png"), (await win.webContents.capturePage()).toPNG());
      }
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#learnedRulesModal').classList.contains('hidden')");
      result.closed = true;

      console.log("__LEARNED_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[learned runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact learned-rules modal opens, refreshes and closes at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) { t.skip(reason); return; }
  const home = makeTempHome("opensand-learned-home-");
  const ws = makeTempHome("opensand-learned-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Learned Rules Real Window Test Workspace\n", "utf8");
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-learned-harness-"));
  const runner = path.join(tmpDir, "runner-learned.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_LEARNED_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-learned-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_LEARNED_SHOT_DIR = proofDir;

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
    assert.strictEqual(code, 0, `learned runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__LEARNED_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);
    assert.ok(res.content.includes("Always use pnpm"), `rules render (${res.content})`);
    assert.strictEqual(res.refreshing, true, "re-analyzing state appears");
    assert.ok(res.summary.includes("No new rules"), `report renders (${res.summary})`);
    assert.strictEqual(res.error, "", "no refresh error");
    assert.strictEqual(res.closed, true, "Esc closes the modal");
    for (const tag of ["compact", "wide"]) {
      const m = res.sizes[tag];
      assert.strictEqual(m.open, true, `${tag} modal open`);
      assert.strictEqual(m.noOverflow, true, `${tag} no overflow`);
      assert.strictEqual(m.cardFits, true, `${tag} card fits`);
      assert.strictEqual(m.contentFits, true, `${tag} content fits`);
    }
    console.log("learned-rules real-window: load/refresh/Esc states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
