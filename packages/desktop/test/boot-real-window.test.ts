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
const shotDir = process.env.OPENSAND_BOOT_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_BOOT_TIMEOUT_MS || 60000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 250; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const measure = () => js("(() => {\n" +
  "const root = document.querySelector('.app-layout');\n" +
  "const shell = document.querySelector('#shellView') || document.querySelector('main');\n" +
  "const r = shell ? shell.getBoundingClientRect() : null;\n" +
  "return {\n" +
    "ready: root ? root.getAttribute('data-boot-status') : null,\n" +
    "phase: root ? root.getAttribute('data-boot-phase') : null,\n" +
    "theme: document.documentElement.getAttribute('data-theme'),\n" +
    "electron: document.body.classList.contains('is-electron'),\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "shellFits: r ? (r.left >= -1 && r.right <= window.innerWidth + 1) : false,\n" +
  "};\n" +
"})()");
const result = { sizes: {}, authModalHidden: null };
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('.app-layout[data-boot-status]')");
      await wait("document.querySelector('.app-layout').getAttribute('data-boot-status') === 'ready'");
      result.authModalHidden = await js("document.querySelector('#authModal') ? document.querySelector('#authModal').classList.contains('hidden') : true");
      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes[tag] = await measure();
        if (shotDir) {
          fs.mkdirSync(shotDir, { recursive: true });
          await js("new Promise((r) => { const done = () => r(true); requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 2000); })");
          fs.writeFileSync(path.join(shotDir, "boot-" + tag + "-" + width + "x" + height + ".png"), (await win.webContents.capturePage()).toPNG());
        }
      }
      console.log("__BOOT_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[boot runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("renderer boot reaches ready with theme and zero overflow at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const home = makeTempHome("opensand-boot-home-");
  const ws = makeTempHome("opensand-boot-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Boot Real Window Test Workspace\n", "utf8");
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-boot-harness-"));
  const runner = path.join(tmpDir, "runner-boot.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");
  const proofDir = process.env.OPENSAND_BOOT_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-boot-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_BOOT_SHOT_DIR = proofDir;

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
        watchdog = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, 150_000);
        void whenElectronExited(child).then(settle);
        child.on("error", (err) => { stderr += String(err); settle(1); });
      });
    });
    assert.strictEqual(code, 0, `boot runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__BOOT_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);
    for (const tag of ["compact", "wide"]) {
      const m = res.sizes[tag];
      assert.strictEqual(m.ready, "ready", `${tag} boot reaches ready`);
      assert.strictEqual(m.phase, "ready", `${tag} boot phase is ready`);
      assert.strictEqual(m.electron, true, `${tag} runs in Electron`);
      assert.ok(m.theme === "light" || m.theme === "dark", `${tag} theme applied (${m.theme})`);
      assert.strictEqual(m.noOverflow, true, `${tag} has no horizontal overflow`);
      assert.strictEqual(m.shellFits, true, `${tag} shell fits`);
    }
    assert.strictEqual(res.authModalHidden, true, "auth modal is hidden in Electron mode");
    console.log("boot real-window: ready phase, theme and 960x740 + 1920x1080 zero-overflow checks passed");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
});
