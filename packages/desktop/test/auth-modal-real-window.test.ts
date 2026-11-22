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

const shotDir = process.env.OPENSAND_AUTH_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_AUTH_TIMEOUT_MS || 120000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const setInput = (value) => "(() => { const i = document.querySelector('#serverAuthTokenInput'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, " + JSON.stringify(value) + "); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
// Effects subscribe after the modal node is painted; retry the notification until the listener is live.
const openModal = async () => {
  for (let i = 0; i < 20; i++) {
    if (!(await js("document.querySelector('#authModal').classList.contains('hidden')"))) break;
    await js("window.dispatchEvent(new CustomEvent('opensand:auth_required'))");
    await sleep(150);
  }
  await wait("!document.querySelector('#authModal').classList.contains('hidden')");
  // Focus is set by the open effect: until it lands, the new handlers may not be wired.
  await wait("document.activeElement === document.querySelector('#serverAuthTokenInput')");
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
};

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const result = {
  hiddenInitially: null,
  fieldsPresent: null,
  emptyError: null,
  submitting: null,
  invalidError: null,
  buttonRestored: null,
  enterSubmission: null,
  sizes: {},
};

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#authModal') && document.body.classList.contains('is-electron')");

      // 1. Hidden by default, with all four required elements present.
      result.hiddenInitially = await js("document.querySelector('#authModal').classList.contains('hidden')");
      result.fieldsPresent = await js("Boolean(document.querySelector('#serverAuthTokenInput') && document.querySelector('#authErrorMsg') && document.querySelector('#btnSubmitAuthToken'))");

      // Stub only the token-exchange route so success/failure are deterministic; every other fetch stays real.
      await js("(() => { window.__authCalls = []; const orig = window.fetch.bind(window); window.fetch = async (input, init) => { const url = String(input && input.url ? input.url : input); if (url.includes('/api/auth/token-exchange')) { const body = JSON.parse((init && init.body) || '{}'); window.__authCalls.push(body.token); if (body.token === 'bad-token') { await new Promise((r) => setTimeout(r, 600)); return new Response(JSON.stringify({ error: 'Unauthorized: invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json' } }); } return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } return orig(input, init); }; return true; })()");

      // 2. A server auth-required notification opens the modal.
      await openModal();
      await wait("!document.querySelector('#authModal').classList.contains('hidden')");
      await shot("auth-modal-open-960x740");

      // 3. Empty submit shows the validation error without calling the server.
      await js("document.querySelector('#btnSubmitAuthToken').click()");
      for (let i = 0; i < 30; i++) {
        if (await js("document.querySelector('#authErrorMsg').style.display === 'block'")) break;
        await sleep(100);
      }
      result.emptyError = await js("document.querySelector('#authErrorMsg').textContent.trim()");
      result.emptyDisplay = await js("document.querySelector('#authErrorMsg').style.display");
      result.emptyValue = await js("document.querySelector('#serverAuthTokenInput').value");
      result.emptyCalls = await js("window.__authCalls.length");
      result.emptyNoFetch = await js("window.__authCalls.length === 0");

      // 4. Invalid token: the button enters the submitting state, then shows the server error.
      await js(setInput("bad-token"));
      await js("document.querySelector('#btnSubmitAuthToken').click()");
      await wait("document.querySelector('#btnSubmitAuthToken').disabled === true");
      result.submitting = await js("document.querySelector('#btnSubmitAuthToken').textContent.trim()");
      await wait("document.querySelector('#authErrorMsg').textContent.includes('invalid token')");
      result.invalidError = await js("document.querySelector('#authErrorMsg').textContent.trim()");
      await wait("document.querySelector('#btnSubmitAuthToken').disabled === false");
      result.buttonRestored = await js("document.querySelector('#btnSubmitAuthToken').textContent.trim()");

      // 5. Enter submits a valid token: storage is written and the modal closes.
      const goodToken = "a".repeat(64);
      await js(setInput(goodToken));
      await js("document.querySelector('#serverAuthTokenInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
      await wait("document.querySelector('#authModal').classList.contains('hidden')");
      result.enterSubmission = await js("({ stored: sessionStorage.getItem('opensand_token'), calls: window.__authCalls })");
      await shot("auth-modal-success-dismissed");

      // 6. Layout at both viewports while the modal is open.
      await openModal();
      await wait("!document.querySelector('#authModal').classList.contains('hidden')");
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        const metrics = await js("(() => {\n" +
          "const q = (s) => document.querySelector(s);\n" +
          "const modal = q('#authModal');\n" +
          "const card = q('#authModal .modal-card');\n" +
          "const input = q('#serverAuthTokenInput');\n" +
          "const btn = q('#btnSubmitAuthToken');\n" +
          "const r = card ? card.getBoundingClientRect() : null;\n" +
          "return {\n" +
            "open: modal ? !modal.classList.contains('hidden') : false,\n" +
            "cardVisible: r ? (r.width > 0 && r.height > 0) : false,\n" +
            "cardFits: r ? (r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1) : false,\n" +
            "inputVisible: input ? input.getBoundingClientRect().width > 0 : false,\n" +
            "buttonVisible: btn ? btn.getBoundingClientRect().width > 0 : false,\n" +
            "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
            "scrollWidth: document.documentElement.scrollWidth,\n" +
            "innerWidth: window.innerWidth,\n" +
          "};\n" +
        "})()");
        await shot("auth-modal-" + tag + "-" + width + "x" + height);
        result.sizes[tag] = metrics;
      }

      console.log("__AUTH_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[auth runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact auth modal and token exchange real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-auth-home-");
  const ws = makeTempHome("opensand-auth-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Auth Modal Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-auth-harness-"));
  const runner = path.join(tmpDir, "runner-auth.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_AUTH_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-auth-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  // os.homedir() ignores HOME on macOS: the state dir must be explicit or the test touches live state.
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_AUTH_SHOT_DIR = proofDir;

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
      return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
    });

    assert.strictEqual(code, 0, `auth runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__AUTH_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.strictEqual(res.hiddenInitially, true, "auth modal is hidden by default");
    assert.strictEqual(res.fieldsPresent, true, "modal exposes input, error container and submit button");
    assert.strictEqual(res.emptyError, "Please enter an authentication token.", `empty submit shows the validation error (${JSON.stringify({ display: res.emptyDisplay, value: res.emptyValue, calls: res.emptyCalls })})`);
    assert.strictEqual(res.emptyNoFetch, true, "empty submit never calls the exchange endpoint");
    assert.strictEqual(res.submitting, "Authenticating...", "submit disables and relabels the button");
    assert.strictEqual(res.invalidError, "Unauthorized: invalid token", "server error is displayed in #authErrorMsg");
    assert.strictEqual(res.buttonRestored, "Connect & Authenticate", "button is re-enabled after a failed exchange");
    assert.strictEqual(res.enterSubmission.stored, "a".repeat(64), "successful exchange persists 64-char token in sessionStorage");
    assert.deepStrictEqual(res.enterSubmission.calls, ["bad-token", "a".repeat(64)], "Enter submits exactly one valid exchange");

    for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
      const size = res.sizes[tag];
      assert.ok(size, `${tag} ${width}x${height} metrics present`);
      assert.strictEqual(size.open, true, `${tag}: modal open at ${width}x${height}`);
      assert.strictEqual(size.cardVisible, true, `${tag}: card visible at ${width}x${height}`);
      assert.strictEqual(size.cardFits, true, `${tag}: card fits inside the window at ${width}x${height}`);
      assert.strictEqual(size.inputVisible, true, `${tag}: token input visible at ${width}x${height}`);
      assert.strictEqual(size.buttonVisible, true, `${tag}: submit button visible at ${width}x${height}`);
      assert.strictEqual(size.noOverflow, true, `${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
    }

    console.log("[proof] auth modal real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
