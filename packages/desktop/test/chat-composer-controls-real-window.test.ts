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

const shotDir = process.env.OPENSAND_CHAT_CONTROLS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_CHAT_CONTROLS_TIMEOUT_MS || 90000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
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
      await wait("document.querySelector('#promptInput') && document.querySelector('#btnToggleSafeMode') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#chat", "#viewChat");
      await wait("document.querySelector('#promptInput').getBoundingClientRect().width > 0");

      const result = { sizes: {}, modeCycled: false, newlineKept: false };
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [w, h, tag] of SIZES) {
        win.setContentSize(w, h);
        await wait("window.innerWidth === " + w);
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        const metrics = await js("(() => {\n" +
          "const model = document.querySelector('#composerModelBadge');\n" +
          "const tokens = document.querySelector('#composerTokenBadge');\n" +
          "const mode = document.querySelector('#btnToggleSafeMode');\n" +
          "const modeText = document.querySelector('#composerAutoApproveText');\n" +
          "const box = (el) => el ? el.getBoundingClientRect() : null;\n" +
          "const mb = box(model), tb = box(tokens), db = box(mode);\n" +
          "return {\n" +
            "hasModel: Boolean(model && mb.width > 0 && mb.bottom <= window.innerHeight),\n" +
            "hasTokens: Boolean(tokens && tb.width > 0 && tb.bottom <= window.innerHeight),\n" +
            "hasModeButton: Boolean(mode && db.width > 0 && db.bottom <= window.innerHeight),\n" +
            "tokenText: tokens ? tokens.textContent.trim() : '',\n" +
            "modelTitle: model ? model.getAttribute('title') : '',\n" +
            "modeText: modeText ? modeText.textContent.trim() : '',\n" +
            "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
          "};\n" +
        "})()");
        await shot("chat-controls-" + tag + "-" + w + "x" + h);
        result.sizes[tag] = metrics;
      }

      const before = result.sizes.compact.modeText;
      await js("document.querySelector('#btnToggleSafeMode').click()");
      await wait("document.querySelector('#composerAutoApproveText').textContent.trim() !== " + JSON.stringify(before));
      const after = await js("document.querySelector('#composerAutoApproveText').textContent.trim()");
      result.modeCycled = before !== after && ["Safe Mode", "Auto-Edit", "Auto-Approve"].includes(after);

      await js("(() => {\n" +
        "const p = document.querySelector('#promptInput');\n" +
        "p.value = 'first line';\n" +
        "p.dispatchEvent(new Event('input', { bubbles: true }));\n" +
        "p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));\n" +
      "})()");
      await sleep(150);
      result.newlineKept = await js("document.querySelector('#promptInput').value === 'first line'");

      console.log("__CHAT_CONTROLS_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[chat controls runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact chat composer controls real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-chat-controls-home-");
  const ws = makeTempHome("opensand-chat-controls-ws-");
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-controls-harness-"));
  const runner = path.join(tmpDir, "runner-chat-controls.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-controls-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_CHAT_CONTROLS_SHOT_DIR = proofDir;

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

    assert.strictEqual(code, 0, `chat controls runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__CHAT_CONTROLS_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    for (const [tag, size] of Object.entries(res.sizes) as Array<[string, any]>) {
      assert.strictEqual(size.hasModel, true, `model badge visible at ${tag}`);
      assert.strictEqual(size.hasTokens, true, `token badge visible at ${tag}`);
      assert.strictEqual(size.hasModeButton, true, `mode button visible at ${tag}`);
      assert.match(size.tokenText, /^[\d.,kM]+ \/ [\d.,kM]+ \(\S+\)$/, `token badge text at ${tag}`);
      assert.match(size.modelTitle, /^Active Model:/, `model badge title at ${tag}`);
      assert.strictEqual(size.noOverflow, true, `zero horizontal overflow at ${tag}`);
    }
    assert.strictEqual(res.modeCycled, true, "Safe Mode button cycles the approval mode");
    assert.strictEqual(res.newlineKept, true, "Shift+Enter keeps the newline in the composer");

    console.log("[proof] chat composer control screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
