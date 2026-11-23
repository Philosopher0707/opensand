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

const shotDir = process.env.OPENSAND_INSPECTOR_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_INSPECTOR_TIMEOUT_MS || 90000);

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
      await wait("document.querySelector('#btnToggleDetail') && document.body.classList.contains('is-electron')");

      const result = { sizes: {}, shortcuts: {} };
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];

      for (const [w, h, tag] of SIZES) {
        win.setContentSize(w, h);
        await sleep(400);

        // Verify initial closed state
        const initialClosed = await js("document.querySelector('#detailPanel')?.classList.contains('hidden')");

        // Open via #btnToggleDetail
        await js("document.querySelector('#btnToggleDetail').click()");
        await wait("!document.querySelector('#detailPanel').classList.contains('hidden')");
        await sleep(300);

        const metrics = await js("(() => {\n" +
          "const panel = document.querySelector('#detailPanel');\n" +
          "const btnToggle = document.querySelector('#btnToggleDetail');\n" +
          "const avatar = document.querySelector('#detailBotAvatar');\n" +
          "const name = document.querySelector('#detailBotName');\n" +
          "const role = document.querySelector('#detailBotRole');\n" +
          "const model = document.querySelector('#detailBotModelCode');\n" +
          "const prompt = document.querySelector('#detailBotPromptPreview');\n" +
          "const tokensUsed = document.querySelector('#detailTokensUsed');\n" +
          "const meterFill = document.querySelector('#detailMeterFill');\n" +
          "const tokensMax = document.querySelector('#detailTokensMax');\n" +
          "const tokensPct = document.querySelector('#detailTokensPct');\n" +
          "const memoriesList = document.querySelector('#detailMemoriesList');\n" +
          "const skillsTags = document.querySelector('#detailSkillsTags');\n" +
          "const btnRewind = document.querySelector('#btnDetailRewind');\n" +
          "const btnCompact = document.querySelector('#btnDetailCompact');\n" +
          "const btnExport = document.querySelector('#btnDetailExportBot');\n" +
          "const btnClear = document.querySelector('#btnDetailClear');\n" +
          "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
          "return {\n" +
            "isOpen: panel && !panel.classList.contains('hidden'),\n" +
            "toggleActive: btnToggle && btnToggle.classList.contains('active'),\n" +
            "panelVisible: pr ? (pr.width > 0 && pr.height > 0) : false,\n" +
            "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
            "avatarText: avatar ? avatar.textContent.trim() : '',\n" +
            "botName: name ? name.textContent.trim() : '',\n" +
            "botRole: role ? role.textContent.trim() : '',\n" +
            "botModel: model ? model.textContent.trim() : '',\n" +
            "hasPrompt: Boolean(prompt && prompt.textContent.trim().length > 0),\n" +
            "hasTokensUsed: Boolean(tokensUsed && tokensUsed.textContent.includes('tokens')),\n" +
            "hasMeterFill: Boolean(meterFill),\n" +
            "hasTokensMax: Boolean(tokensMax && tokensMax.textContent.length > 0),\n" +
            "hasTokensPct: Boolean(tokensPct && tokensPct.textContent.includes('%')),\n" +
            "hasMemories: Boolean(memoriesList && memoriesList.children.length > 0),\n" +
            "skillsCount: skillsTags ? skillsTags.querySelectorAll('.detail-skill-chip').length : 0,\n" +
            "hasControls: Boolean(btnRewind && btnCompact && btnExport && btnClear),\n" +
          "};\n" +
        "})()");

        await shot("inspector-" + tag + "-" + w + "x" + h);

        // Close via #btnCloseDetail
        await js("document.querySelector('#btnCloseDetail').click()");
        await wait("document.querySelector('#detailPanel').classList.contains('hidden')");
        const closedAfterBtn = await js("document.querySelector('#detailPanel')?.classList.contains('hidden')");

        result.sizes[tag] = { initialClosed, metrics, closedAfterBtn };
      }

      // Test keyboard shortcuts
      // 1. Open with Cmd/Ctrl+I
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))");
      await wait("!document.querySelector('#detailPanel').classList.contains('hidden')");
      const openedViaShortcut = await js("!document.querySelector('#detailPanel').classList.contains('hidden')");
      await sleep(200);

      // 2. Close with Esc
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await wait("document.querySelector('#detailPanel').classList.contains('hidden')");
      const closedViaEscape = await js("document.querySelector('#detailPanel').classList.contains('hidden')");

      result.shortcuts = { openedViaShortcut, closedViaEscape };

      console.log("__INSPECTOR_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[inspector runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact Detail Inspector real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-inspector-home-");
  const ws = makeTempHome("opensand-inspector-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Inspector Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-inspector-harness-"));
  const runner = path.join(tmpDir, "runner-inspector.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-inspector-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_INSPECTOR_SHOT_DIR = proofDir;

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
      return whenElectronExited(child);
    });

    assert.strictEqual(code, 0, `inspector runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__INSPECTOR_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    // Check compact 960x740 metrics
    const compact = res.sizes.compact;
    assert.ok(compact, "compact 960x740 results present");
    assert.strictEqual(compact.initialClosed, true, "inspector initially hidden at 960x740");
    assert.strictEqual(compact.metrics.isOpen, true, "inspector opened via #btnToggleDetail");
    assert.strictEqual(compact.metrics.toggleActive, true, "#btnToggleDetail has active class");
    assert.strictEqual(compact.metrics.panelVisible, true, "inspector panel has visible bounds");
    assert.strictEqual(compact.metrics.noOverflow, true, "zero horizontal overflow at 960x740");
    assert.ok(compact.metrics.botName.length > 0, "active persona name rendered");
    assert.ok(compact.metrics.botRole.length > 0, "active persona role rendered");
    assert.ok(compact.metrics.botModel.length > 0, "active persona model tag rendered");
    assert.strictEqual(compact.metrics.hasPrompt, true, "active persona prompt preview rendered");
    assert.strictEqual(compact.metrics.hasTokensUsed, true, "tokens used telemetry rendered");
    assert.strictEqual(compact.metrics.hasMeterFill, true, "tokens meter fill rendered");
    assert.strictEqual(compact.metrics.hasTokensMax, true, "tokens max limit rendered");
    assert.strictEqual(compact.metrics.hasTokensPct, true, "tokens pct rendered");
    assert.strictEqual(compact.metrics.hasMemories, true, "cognitive memories section rendered");
    assert.ok(compact.metrics.skillsCount >= 1, "granted skill chips rendered");
    assert.strictEqual(compact.metrics.hasControls, true, "all 4 session control buttons rendered");
    assert.strictEqual(compact.closedAfterBtn, true, "closed via #btnCloseDetail at 960x740");

    // Check wide 1920x1080 metrics
    const wide = res.sizes.wide;
    assert.ok(wide, "wide 1920x1080 results present");
    assert.strictEqual(wide.initialClosed, true, "inspector initially hidden at 1920x1080");
    assert.strictEqual(wide.metrics.isOpen, true, "inspector opened via #btnToggleDetail at 1920x1080");
    assert.strictEqual(wide.metrics.toggleActive, true, "#btnToggleDetail has active class");
    assert.strictEqual(wide.metrics.panelVisible, true, "inspector panel has visible bounds");
    assert.strictEqual(wide.metrics.noOverflow, true, "zero horizontal overflow at 1920x1080");
    assert.ok(wide.metrics.botName.length > 0, "active persona name rendered");
    assert.strictEqual(wide.closedAfterBtn, true, "closed via #btnCloseDetail at 1920x1080");

    // Check keyboard shortcuts
    assert.strictEqual(res.shortcuts.openedViaShortcut, true, "opened via Cmd+I keyboard shortcut");
    assert.strictEqual(res.shortcuts.closedViaEscape, true, "closed via Escape keyboard shortcut");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
