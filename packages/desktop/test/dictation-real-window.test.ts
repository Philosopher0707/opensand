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

const shotDir = process.env.OPENSAND_DICTATION_SHOT_DIR || "";
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 120)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 150; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#promptInput') && document.querySelector('#btnDictate') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#chat", "#viewChat");
      await wait("document.querySelector('#promptInput').getBoundingClientRect().width > 0");

      // Install a Web Speech API double before the composer creates its controller on first click.
      await js("(function(){\n" +
        "class FakeRecognition {\n" +
        "  constructor(){ this.calls=[]; this.onstart=null; this.onresult=null; this.onerror=null; this.onend=null; window.__dictationFake=this; }\n" +
        "  start(){ this.calls.push('start'); if(this.onstart) this.onstart(); }\n" +
        "  stop(){ this.calls.push('stop'); if(this.onend) this.onend(); }\n" +
        "  abort(){ this.calls.push('abort'); if(this.onend) this.onend(); }\n" +
        "  emit(final, interim){ const results=[]; if(final) results.push({isFinal:true,0:{transcript:final}}); if(interim) results.push({isFinal:false,0:{transcript:interim}}); if(this.onresult) this.onresult({resultIndex:0,results}); }\n" +
        "  fail(code){ if(this.onerror) this.onerror({error:code}); if(this.onend) this.onend(); }\n" +
        "}\n" +
        "window.SpeechRecognition=FakeRecognition; window.webkitSpeechRecognition=FakeRecognition;\n" +
        "})()");

      win.setContentSize(960, 740);
      await sleep(400);

      const metrics = await js("(() => {\n" +
        "const b = document.querySelector('#btnDictate');\n" +
        "const r = b ? b.getBoundingClientRect() : null;\n" +
        "return {\n" +
        "  present: Boolean(b),\n" +
        "  label: b ? b.querySelector('span:last-child').textContent.trim() : '',\n" +
        "  visible: r ? (r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight) : false,\n" +
        "  noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
        "};\n" +
      "})()");
      await shot("dictate-button-idle");

      // Dictate inserts the spoken text after the existing draft.
      await js("(() => { const p=document.querySelector('#promptInput'); p.value='Draft: '; p.dispatchEvent(new Event('input',{bubbles:true})); })()");
      await js("document.querySelector('#btnDictate').click()");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'listening'");
      const listeningLabel = await js("document.querySelector('#btnDictate span:last-child').textContent.trim()");
      await shot("dictate-button-listening");

      await js("window.__dictationFake.emit('hello world', '')");
      await wait("document.querySelector('#promptInput').value === 'Draft: hello world'");
      const inserted = await js("document.querySelector('#promptInput').value");

      // Stop keeps the transcript and returns the button to idle.
      await js("document.querySelector('#btnDictate').click()");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'idle'");
      const stopCalls = await js("window.__dictationFake.calls.filter(c => c === 'stop').length");
      const afterStop = await js("document.querySelector('#promptInput').value");

      // Empty speech inserts nothing.
      await js("document.querySelector('#btnDictate').click()");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'listening'");
      await js("window.__dictationFake.emit('', '  ')");
      await sleep(100);
      const afterEmpty = await js("document.querySelector('#promptInput').value");
      await js("document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'idle'");

      // Escape cancels: interim speech is discarded and the pre-dictation draft returns.
      await js("document.querySelector('#btnDictate').click()");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'listening'");
      await js("window.__dictationFake.emit('', 'half-heard words')");
      await wait("document.querySelector('#promptInput').value === 'Draft: hello world half-heard words'");
      await js("document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'idle'");
      const abortCalls = await js("window.__dictationFake.calls.filter(c => c === 'abort').length");
      const afterCancel = await js("document.querySelector('#promptInput').value");

      // Permission denied shows a plain message, never the raw error code.
      await js("document.querySelector('#btnDictate').click()");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'listening'");
      await js("window.__dictationFake.fail('not-allowed')");
      await wait("document.body.innerText.includes('Microphone access was denied')");
      const permissionNotice = await js("document.body.innerText");
      const idleAfterDenied = await js("document.querySelector('#btnDictate').getAttribute('data-state') === 'idle'");

      // An unknown error with attacker-shaped text never reaches the page.
      await js("document.querySelector('#btnDictate').click()");
      await wait("document.querySelector('#btnDictate').getAttribute('data-state') === 'listening'");
      await js("window.__dictationFake.fail('internal NotAllowedError file:///Users/me/secret token=abc123')");
      await sleep(150);
      const errorBody = await js("document.body.innerText");
      const idleAfterError = await js("document.querySelector('#btnDictate').getAttribute('data-state') === 'idle'");

      const result = {
        metrics, listeningLabel, inserted, stopCalls, afterStop, afterEmpty, abortCalls, afterCancel,
        deniedIsPlain: permissionNotice.includes('Microphone access was denied') && !permissionNotice.includes('not-allowed'),
        idleAfterDenied,
        noRawError: !errorBody.includes('NotAllowedError') && !errorBody.includes('file:///') && !errorBody.includes('abc123'),
        idleAfterError,
      };
      console.log("__DICTATION_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[dictation runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact composer Dictate button real-window test at 960x740", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-dictation-home-");
  const ws = makeTempHome("opensand-dictation-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Dictation Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-dictation-harness-"));
  const runner = path.join(tmpDir, "runner-dictation.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-dictation-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_DICTATION_SHOT_DIR = proofDir;

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
      return whenElectronExited(child);
    });

    assert.strictEqual(code, 0, `dictation runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__DICTATION_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.strictEqual(res.metrics.present, true, "Dictate button present in the built composer");
    assert.strictEqual(res.metrics.label, "Dictate", "idle button label matches legacy");
    assert.strictEqual(res.metrics.visible, true, "Dictate button visible at 960x740");
    assert.strictEqual(res.metrics.noOverflow, true, "no horizontal overflow at 960x740");
    assert.strictEqual(res.listeningLabel, "Listening...", "listening label matches legacy");
    assert.strictEqual(res.inserted, "Draft: hello world", "final speech inserted after existing draft");
    assert.strictEqual(res.stopCalls, 1, "clicking while listening calls stop once");
    assert.strictEqual(res.afterStop, "Draft: hello world", "stop keeps the transcript");
    assert.strictEqual(res.afterEmpty, "Draft: hello world", "empty speech inserts nothing");
    assert.strictEqual(res.abortCalls, 2, "Escape aborts each listening session");
    assert.strictEqual(res.afterCancel, "Draft: hello world", "cancel restores the pre-dictation draft");
    assert.strictEqual(res.deniedIsPlain, true, "permission denied shows only a plain message");
    assert.strictEqual(res.idleAfterDenied, true, "button returns to idle after permission denied");
    assert.strictEqual(res.noRawError, true, "raw error text never reaches the page");
    assert.strictEqual(res.idleAfterError, true, "button never sticks in listening after an error");

    assert.ok(fs.existsSync(path.join(proofDir, "dictate-button-idle.png")), "idle screenshot written");
    assert.ok(fs.existsSync(path.join(proofDir, "dictate-button-listening.png")), "listening screenshot written");
    console.log("[proof] dictation screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
