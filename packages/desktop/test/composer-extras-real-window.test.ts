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

const shotDir = process.env.OPENSAND_COMPOSER_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_COMPOSER_TIMEOUT_MS || 90000);

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
      await wait("document.querySelector('#promptInput') && document.querySelector('#btnAttachFile') && document.body.classList.contains('is-electron')");

      const result = { sizes: {}, chipInteraction: false, popoverInteraction: false, dragDropInteraction: false, attachmentInteraction: false };
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];

      for (const [w, h, tag] of SIZES) {
        win.setContentSize(w, h);
        await sleep(400);

        const metrics = await js("(() => {\n" +
          "const input = document.querySelector('#promptInput');\n" +
          "const btnSend = document.querySelector('#btnSend');\n" +
          "const btnAttach = document.querySelector('#btnAttachFile');\n" +
          "const fileInput = document.querySelector('#fileAttachmentInput');\n" +
          "const chipsStrip = document.querySelector('.prompt-chips-strip');\n" +
          "const chips = chipsStrip ? chipsStrip.querySelectorAll('.prompt-chip') : [];\n" +
          "const ir = input ? input.getBoundingClientRect() : null;\n" +
          "return {\n" +
            "hasInput: Boolean(input),\n" +
            "hasBtnSend: Boolean(btnSend),\n" +
            "hasBtnAttach: Boolean(btnAttach),\n" +
            "hasFileInput: Boolean(fileInput),\n" +
            "chipsCount: chips.length,\n" +
            "inputVisible: ir ? (ir.width > 0 && ir.top >= 0 && ir.bottom <= window.innerHeight) : false,\n" +
            "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
          "};\n" +
        "})()");

        await shot("composer-" + tag + "-" + w + "x" + h);
        result.sizes[tag] = metrics;
      }

      // 1. Test Quick Prompt Chip interaction
      const promptBefore = await js("document.querySelector('#promptInput').value");
      await js("document.querySelector('.prompt-chip')?.click()");
      await sleep(150);
      const promptAfterChip = await js("document.querySelector('#promptInput').value");
      result.chipInteraction = Boolean(promptAfterChip && promptAfterChip.length > promptBefore.length);

      // Clear input
      await js("(() => { const p = document.querySelector('#promptInput'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await sleep(100);

      // 2. Test Autocomplete Slash Popover interaction
      // Type '/comp'
      await js("(() => {\n" +
        "const p = document.querySelector('#promptInput');\n" +
        "p.value = '/comp';\n" +
        "p.setSelectionRange(5, 5);\n" +
        "p.dispatchEvent(new Event('input', { bubbles: true }));\n" +
      "})()");
      await wait("document.querySelector('#triggerPopover') && document.querySelectorAll('.trigger-item').length > 0");

      const popoverVisible = await js("Boolean(document.querySelector('#triggerPopover'))");
      const itemsCount = await js("document.querySelectorAll('.trigger-item').length");

      // Test keyboard navigation (ArrowDown)
      await js("document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
      await sleep(100);

      // Select item by clicking the active item
      await js("document.querySelector('.trigger-item.active')?.click()");
      await sleep(150);

      const promptAfterPopover = await js("document.querySelector('#promptInput').value");
      const popoverClosed = await js("!document.querySelector('#triggerPopover')");

      result.popoverInteraction = Boolean(popoverVisible && itemsCount > 0 && promptAfterPopover.includes("/compact") && popoverClosed);
      await shot("composer-popover-inserted");

      // Clear input
      await js("(() => { const p = document.querySelector('#promptInput'); p.value = ''; p.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await sleep(100);

      // 3. Test Drag and Drop hover state
      await js("(() => {\n" +
        "const w = document.querySelector('.input-wrapper');\n" +
        "w.dispatchEvent(new DragEvent('dragenter', { bubbles: true }));\n" +
      "})()");
      await sleep(100);
      const dragOverActive = await js("document.querySelector('.input-wrapper').classList.contains('drag-over')");

      await js("(() => {\n" +
        "const w = document.querySelector('.input-wrapper');\n" +
        "w.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));\n" +
      "})()");
      await sleep(100);
      const dragOverInactive = await js("!document.querySelector('.input-wrapper').classList.contains('drag-over')");

      result.dragDropInteraction = Boolean(dragOverActive && dragOverInactive);

      // 4. Test Staged Attachments Strip
      // Simulate drop of a mock file onto .input-wrapper
      await js("(() => {\n" +
        "const dt = new DataTransfer();\n" +
        "const file = new File(['mock content for test'], 'test-schema.ts', { type: 'text/typescript' });\n" +
        "dt.items.add(file);\n" +
        "const w = document.querySelector('.input-wrapper');\n" +
        "w.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));\n" +
      "})()");
      await wait("document.querySelector('#attachmentStrip') && document.querySelectorAll('.attachment-chip').length > 0");

      const hasAttachmentChip = await js("Boolean(document.querySelector('.attachment-chip'))");
      const attName = await js("document.querySelector('.attachment-chip-name')?.textContent || ''");
      const attSize = await js("document.querySelector('.attachment-chip-size')?.textContent || ''");

      await shot("composer-staged-attachment");

      // Remove attachment via .btn-remove-attachment
      await js("document.querySelector('.btn-remove-attachment')?.click()");
      await sleep(150);
      const attachmentRemoved = await js("!document.querySelector('.attachment-chip')");

      result.attachmentInteraction = Boolean(hasAttachmentChip && attName.includes("test-schema.ts") && attSize.length > 0 && attachmentRemoved);

      console.log("__COMPOSER_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[composer runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact Chat Composer Extras real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-composer-home-");
  const ws = makeTempHome("opensand-composer-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Composer Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-composer-harness-"));
  const runner = path.join(tmpDir, "runner-composer.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-composer-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_COMPOSER_SHOT_DIR = proofDir;

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

    assert.strictEqual(code, 0, `composer runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__COMPOSER_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    // Check compact 960x740 metrics
    const compact = res.sizes.compact;
    assert.ok(compact, "compact 960x740 results present");
    assert.strictEqual(compact.hasInput, true, "prompt input present at 960x740");
    assert.strictEqual(compact.hasBtnSend, true, "send button present at 960x740");
    assert.strictEqual(compact.hasBtnAttach, true, "attach button present at 960x740");
    assert.strictEqual(compact.hasFileInput, true, "hidden file input present at 960x740");
    assert.ok(compact.chipsCount >= 4, "quick prompt chips rendered at 960x740");
    assert.strictEqual(compact.inputVisible, true, "input field within viewport at 960x740");
    assert.strictEqual(compact.noOverflow, true, "zero horizontal overflow at 960x740");

    // Check wide 1920x1080 metrics
    const wide = res.sizes.wide;
    assert.ok(wide, "wide 1920x1080 results present");
    assert.strictEqual(wide.hasInput, true, "prompt input present at 1920x1080");
    assert.strictEqual(wide.hasBtnSend, true, "send button present at 1920x1080");
    assert.strictEqual(wide.hasBtnAttach, true, "attach button present at 1920x1080");
    assert.ok(wide.chipsCount >= 4, "quick prompt chips rendered at 1920x1080");
    assert.strictEqual(wide.inputVisible, true, "input field within viewport at 1920x1080");
    assert.strictEqual(wide.noOverflow, true, "zero horizontal overflow at 1920x1080");

    // Check interactions
    assert.strictEqual(res.chipInteraction, true, "clicking quick prompt chip populates input");
    assert.strictEqual(res.popoverInteraction, true, "slash trigger popover autocompletes command into input");
    assert.strictEqual(res.dragDropInteraction, true, "dragenter and dragleave toggle drag-over hover state");
    assert.strictEqual(res.attachmentInteraction, true, "staged file attachment creates chip and removal works");

    console.log("[proof] composer real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
