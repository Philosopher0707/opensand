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
const shotDir = process.env.OPENSAND_ACTIONS_SHOT_DIR || "";
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 250; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
const setNumber = (sel, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
const measure = (id) => js("(() => {\n" +
  "const panel = document.querySelector('#" + id + "');\n" +
  "const card = panel && panel.querySelector('.modal-card') ? panel.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return { open: panel ? !panel.classList.contains('hidden') : false, scrollWidth: document.documentElement.scrollWidth, noOverflow: document.documentElement.scrollWidth <= window.innerWidth, cardFits: card ? (card.left >= -1 && card.right <= window.innerWidth + 1 && card.top >= -1 && card.bottom <= window.innerHeight + 1) : false };\n" +
"})()");
const openMenu = async () => {
  await js("document.querySelector('#accountMenuTrigger').click()");
  await wait("!document.querySelector('#accountPopup').classList.contains('hidden')");
};
const result = { btw: {}, rollback: {}, compact: {}, sizes: {} };
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#accountMenuTrigger') && document.body.classList.contains('is-electron')");
      await js("(() => {\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const body = JSON.parse((init && init.body) || '{}');\n" +
          "if (url.includes('/api/btw')) {\n" +
            "if (!body.question || !body.question.trim()) return new Response(JSON.stringify({ error: 'Please type a question first.' }), { status: 400 });\n" +
            "return new Response(JSON.stringify({ answer: 'Use pnpm and verify with tests.' }), { status: 200 });\n" +
          "}\n" +
          "if (url.includes('/api/rollback')) return new Response(JSON.stringify({ removedMessages: body.turns, remainingMessages: 7 }), { status: 200 });\n" +
          "if (url.includes('/api/compact')) return new Response(JSON.stringify({ originalTokens: 900, compactedTokens: 300, compactedTurnCount: body.keepRecentTurns }), { status: 200 });\n" +
          "return orig(input, init);\n" +
        "};\n" +
        "return true;\n" +
      "})()");

      // BTW: validation, answer, empty fallback copy.
      await openMenu();
      await js("document.querySelector('#btnOpenBtw').click()");
      await wait("!document.querySelector('#btwModal').classList.contains('hidden')");
      await sleep(300);
      await js("document.querySelector('#btnSubmitBtw').click()");
      await sleep(500);
      result.btw.validation = await js("document.querySelector('.session-action-error').textContent.trim()");
      await js(nativeSet('#btwQuestion', 'Which package manager?'));
      await js("document.querySelector('#btnSubmitBtw').click()");
      await sleep(500);
      await wait("document.querySelector('#btwAnswerContent') && document.querySelector('#btwAnswerContent').textContent.includes('pnpm')");
      result.btw.answer = await js("document.querySelector('#btwAnswerContent').textContent.trim()");
      result.btw.askAnother = await js("document.querySelector('#btnSubmitBtw').textContent.trim()");
      if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(path.join(shotDir, "btw-960x740.png"), (await win.webContents.capturePage()).toPNG()); }
      await js("document.querySelector('#btnCloseBtwDone').click()");
      await wait("document.querySelector('#btwModal').classList.contains('hidden')");

      // Rollback: default turns and a success result.
      await openMenu();
      await js("document.querySelector('#btnOpenRollback').click()");
      await wait("!document.querySelector('#rollbackModal').classList.contains('hidden')");
      await sleep(300);
      result.rollback.defaultTurns = await js("document.querySelector('#rollbackTurnCount').value");
      await js(setNumber('#rollbackTurnCount', '3'));
      await js("document.querySelector('#btnConfirmRollback').click()");
      await wait("document.querySelector('#rollbackStatusBox') && document.querySelector('#rollbackStatusBox').textContent.includes('rolled back 3')");
      result.rollback.status = await js("document.querySelector('#rollbackStatusBox').textContent.trim()");
      await js("document.querySelector('#btnCloseRollbackAction').click()");
      await wait("document.querySelector('#rollbackModal').classList.contains('hidden')");

      // Compact: default keep and a success result.
      await openMenu();
      await js("document.querySelector('#btnOpenCompact').click()");
      await wait("!document.querySelector('#compactModal').classList.contains('hidden')");
      await sleep(300);
      result.compact.defaultKeep = await js("document.querySelector('#compactKeepTurns').value");
      await js(setNumber('#compactKeepTurns', '5'));
      await js("document.querySelector('#btnConfirmCompact').click()");
      await wait("document.querySelector('#compactResultBox') && document.querySelector('#compactResultBox').textContent.includes('condensed 5')");
      result.compact.status = await js("document.querySelector('#compactResultBox').textContent.trim()");

      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes[tag] = { compactModal: await measure('compactModal') };
        if (shotDir) fs.writeFileSync(path.join(shotDir, "compact-" + tag + "-" + width + "x" + height + ".png"), (await win.webContents.capturePage()).toPNG());
      }
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#compactModal').classList.contains('hidden')");
      result.compact.escClosed = true;

      console.log("__ACTIONS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[actions runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact BTW, rollback and compact modals at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) { t.skip(reason); return; }
  const home = makeTempHome("opensand-actions-home-");
  const ws = makeTempHome("opensand-actions-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Session Actions Real Window Test Workspace\n", "utf8");
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-actions-harness-"));
  const runner = path.join(tmpDir, "runner-actions.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_ACTIONS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-actions-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });
  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_ACTIONS_SHOT_DIR = proofDir;
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
    assert.strictEqual(code, 0, `actions runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__ACTIONS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);
    assert.strictEqual(res.btw.validation, "Please type a question first.", "empty question is rejected inline");
    assert.ok(res.btw.answer.includes("pnpm"), `BTW answer renders (${res.btw.answer})`);
    assert.strictEqual(res.btw.askAnother, "Ask Another", "submit offers another question");
    assert.strictEqual(res.rollback.defaultTurns, "1", "rollback defaults to one turn");
    assert.ok(res.rollback.status.includes("rolled back 3 messages"), `rollback result renders (${res.rollback.status})`);
    assert.strictEqual(res.compact.defaultKeep, "2", "compact defaults to two turns");
    assert.ok(res.compact.status.includes("condensed 5 turns"), `compact result renders (${res.compact.status})`);
    assert.strictEqual(res.compact.escClosed, true, "Esc closes the compact modal");
    for (const tag of ["compact", "wide"]) {
      const m = res.sizes[tag].compactModal;
      assert.strictEqual(m.open, true, `${tag} modal open`);
      assert.strictEqual(m.noOverflow, true, `${tag} no overflow`);
      assert.strictEqual(m.cardFits, true, `${tag} card fits`);
    }
    console.log("session-actions real-window: validation/answer/rollback/compact/Esc states and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
