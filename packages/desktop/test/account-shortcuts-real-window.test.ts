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

const shotDir = process.env.OPENSAND_ACCOUNT_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_ACCOUNT_TIMEOUT_MS || 120000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 140)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const cmd = (k, shift) => "window.dispatchEvent(new KeyboardEvent('keydown', {key:" + JSON.stringify(k) + ", metaKey:true, shiftKey:" + Boolean(shift) + ", bubbles:true, cancelable:true}))";
const esc = () => "window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))";
const openPopup = async () => { await js("document.querySelector('#accountMenuTrigger').click()"); await wait("!document.querySelector('#accountPopup').classList.contains('hidden')"); };

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const SNAPSHOT = (label) => "(() => {\n" +
  "const q = (s) => document.querySelector(s);\n" +
  "const main = q('.main-panel');\n" +
  "const split = q('.chat-canvas-split');\n" +
  "const detail = q('#detailPanel');\n" +
  "const popup = q('#accountPopup');\n" +
  "const sidebar = q('.sidebar');\n" +
  "const panel = q('.view-panel:not(.hidden)');\n" +
  "return {\n" +
    "label: " + JSON.stringify(label) + ",\n" +
    "theme: document.documentElement.getAttribute('data-theme'),\n" +
    "storedTheme: localStorage.getItem('opensand-theme'),\n" +
    "themeBtnTitle: q('#btnToggleTheme')?.title || '',\n" +
    "themeSvgWidth: Math.round(q('#btnToggleTheme svg')?.getBoundingClientRect().width || 0),\n" +
    "sidebarCollapsed: sidebar ? sidebar.classList.contains('collapsed') : null,\n" +
    "storedSidebar: localStorage.getItem('opensand-sidebar-collapsed'),\n" +
    "toggleActive: q('#btnToggleSidebar')?.classList.contains('active') || false,\n" +
    "toggleTitle: q('#btnToggleSidebar')?.title || '',\n" +
    "popupOpen: popup ? !popup.classList.contains('hidden') : false,\n" +
    "expanded: q('#accountMenuTrigger')?.getAttribute('aria-expanded') || '',\n" +
    "view: panel ? panel.id : null,\n" +
    "hash: window.location.hash,\n" +
    "detailOpen: detail ? !detail.classList.contains('hidden') : false,\n" +
    "canvasOpen: split ? split.getAttribute('data-canvas-open') === 'true' : false,\n" +
    "storedSession: localStorage.getItem('opensand-session-id'),\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth && !!main && main.scrollWidth <= main.clientWidth,\n" +
    "popupFits: popup ? (() => { const r = popup.getBoundingClientRect(); const s = sidebar.getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1 && r.width <= s.width + 1; })() : true,\n" +
  "};\n" +
"})()";

const result = { sizes: {}, theme: {}, sidebar: {}, popup: {}, menu: {}, shortcuts: {}, clear: null };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#accountMenuTrigger') && document.body.classList.contains('is-electron')");
      result.initial = await js(SNAPSHOT("initial"));

      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await wait("window.innerWidth === " + width);
        result.sizes[tag] = await js(SNAPSHOT("initial-" + tag));
        await shot("account-initial-" + tag + "-" + width + "x" + height);
      }
      win.setContentSize(960, 740);
      await wait("window.innerWidth === 960");

      // Theme: topbar button, then the account-menu item (which also closes the popup).
      await js("document.querySelector('#btnToggleTheme').click()");
      await wait("document.documentElement.getAttribute('data-theme') !== " + JSON.stringify(result.initial.theme));
      result.theme.topbar = await js(SNAPSHOT("theme-topbar"));
      await shot("account-theme-toggled");

      await openPopup();
      result.popup.open = await js(SNAPSHOT("popup-open"));
      await shot("account-popup-open");
      await js("document.querySelector('#btnMenuToggleTheme').click()");
      await wait("document.documentElement.getAttribute('data-theme') === " + JSON.stringify(result.initial.theme));
      result.theme.menu = await js(SNAPSHOT("theme-menu"));

      // Sidebar: collapse button, topbar expand button, then Cmd+B both ways.
      await js("document.querySelector('#btnCollapseSidebar').click()");
      await wait("document.querySelector('.sidebar').classList.contains('collapsed')");
      result.sidebar.collapsed = await js(SNAPSHOT("sidebar-collapsed"));
      await shot("account-sidebar-collapsed");
      await js("document.querySelector('#btnToggleSidebar').click()");
      await wait("!document.querySelector('.sidebar').classList.contains('collapsed')");
      result.sidebar.expanded = await js(SNAPSHOT("sidebar-expanded"));
      await js(cmd("b"));
      await wait("document.querySelector('.sidebar').classList.contains('collapsed')");
      result.sidebar.shortcut = await js(SNAPSHOT("sidebar-shortcut"));
      await js(cmd("b"));
      await wait("!document.querySelector('.sidebar').classList.contains('collapsed')");

      // Popup dismissal: outside click, then Esc.
      await openPopup();
      await js("document.elementFromPoint(600, 400).click()");
      await wait("document.querySelector('#accountPopup').classList.contains('hidden')");
      result.popup.outside = await js(SNAPSHOT("popup-outside"));
      await openPopup();
      await js(esc());
      await wait("document.querySelector('#accountPopup').classList.contains('hidden')");
      result.popup.esc = await js(SNAPSHOT("popup-esc"));

      // Menu destinations.
      await openPopup();
      await js("document.querySelector('#btnMenuSentinel').click()");
      await wait("!document.querySelector('#viewSentinel').classList.contains('hidden') && document.querySelector('#accountPopup').classList.contains('hidden')");
      result.menu.sentinel = await js(SNAPSHOT("sentinel"));
      await openPopup();
      await js("document.querySelector('#btnMenuSettings').click()");
      await wait("!document.querySelector('#viewSettings').classList.contains('hidden')");
      result.menu.settings = await js(SNAPSHOT("settings"));
      await shot("account-settings-view");
      await js("document.querySelector('#btnBackToChat').click()");
      await wait("!document.querySelector('#viewChat').classList.contains('hidden')");

      // Clear history resets the active session key.
      await js("localStorage.setItem('opensand-session-id', 's-test')");
      await openPopup();
      await js("document.querySelector('#btnMenuClearSessions').click()");
      await wait("localStorage.getItem('opensand-session-id') === null");
      result.clear = await js(SNAPSHOT("cleared"));

      // Cmd+I toggles details; Esc closes them.
      await js(cmd("i"));
      await wait("!document.querySelector('#detailPanel').classList.contains('hidden')");
      result.shortcuts.detail = await js(SNAPSHOT("detail-open"));
      await js(esc());
      await wait("document.querySelector('#detailPanel').classList.contains('hidden')");
      result.shortcuts.detailEsc = await js(SNAPSHOT("detail-esc"));

      // Cmd+Shift+A toggles the canvas; Esc closes it.
      await js(cmd("a", true));
      await wait("document.querySelector('.chat-canvas-split')?.getAttribute('data-canvas-open') === 'true'");
      result.shortcuts.canvas = await js(SNAPSHOT("canvas-open"));
      await js(esc());
      await wait("document.querySelector('.chat-canvas-split')?.getAttribute('data-canvas-open') === 'false'");
      result.shortcuts.canvasEsc = await js(SNAPSHOT("canvas-esc"));

      // Esc closes the topmost layer only: detail stays open behind the popup.
      await js(cmd("i"));
      await wait("!document.querySelector('#detailPanel').classList.contains('hidden')");
      await openPopup();
      await js(esc());
      await wait("document.querySelector('#accountPopup').classList.contains('hidden')");
      result.shortcuts.escPrecedence = await js(SNAPSHOT("esc-precedence"));
      await js(esc());
      await wait("document.querySelector('#detailPanel').classList.contains('hidden')");

      // Final settled screenshots in both viewports after every toggle.
      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await wait("window.innerWidth === " + width);
        result.sizes["final-" + tag] = await js(SNAPSHOT("final-" + tag));
        await shot("account-final-" + tag + "-" + width + "x" + height);
      }

      console.log("__ACCOUNT_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[account runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});

await import(process.env.OPENSAND_MAIN);
`;

test("Preact account menu, theme, sidebar and shortcuts real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-account-home-");
  const ws = makeTempHome("opensand-account-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Account Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-account-harness-"));
  const runner = path.join(tmpDir, "runner-account.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_ACCOUNT_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-account-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_ACCOUNT_SHOT_DIR = proofDir;

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

    assert.strictEqual(code, 0, `account runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__ACCOUNT_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    // Baseline and layout at both viewports.
    assert.ok(["dark", "light"].includes(res.initial.theme), "a valid theme is applied on mount");
    assert.ok(res.initial.themeSvgWidth >= 12, "the theme toggle icon is visible, not collapsed");
    assert.ok(
      res.initial.storedTheme === null || res.initial.storedTheme === res.initial.theme,
      "no stale or conflicting theme on mount",
    );
    assert.strictEqual(res.initial.sidebarCollapsed, false, "sidebar starts expanded");
    assert.strictEqual(res.initial.popupOpen, false, "account popup starts closed");
    for (const tag of ["compact", "wide", "final-compact", "final-wide"]) {
      assert.ok(res.sizes[tag], `${tag} metrics present`);
      assert.strictEqual(res.sizes[tag].noOverflow, true, `zero horizontal overflow at ${tag}`);
    }
    assert.strictEqual(res.sizes.compact.popupFits, true, "popup stays inside the sidebar at 960x740");

    // Theme toggles from both controls and persists.
    assert.notStrictEqual(res.theme.topbar.theme, res.initial.theme, "topbar button toggles theme");
    assert.strictEqual(res.theme.topbar.theme, res.theme.topbar.storedTheme, "topbar toggle persists");
    assert.strictEqual(res.theme.menu.theme, res.initial.theme, "menu item toggles theme back");
    assert.strictEqual(res.theme.menu.theme, res.theme.menu.storedTheme, "menu toggle persists");
    assert.strictEqual(res.theme.menu.popupOpen, false, "menu theme item closes the popup");
    assert.strictEqual(res.popup.open.popupOpen, true, "trigger opens the popup");
    assert.strictEqual(res.popup.open.expanded, "true", "aria-expanded reflects the open popup");

    // Sidebar collapse from both buttons and Cmd+B, with persistence.
    assert.strictEqual(res.sidebar.collapsed.sidebarCollapsed, true, "collapse button collapses the sidebar");
    assert.strictEqual(res.sidebar.collapsed.storedSidebar, "true", "collapse persists");
    assert.strictEqual(res.sidebar.collapsed.toggleActive, true, "topbar toggle shows active when collapsed");
    assert.strictEqual(res.sidebar.collapsed.toggleTitle, "Expand Sidebar (Cmd+B)", "topbar title flips when collapsed");
    assert.strictEqual(res.sidebar.expanded.sidebarCollapsed, false, "topbar button expands the sidebar");
    assert.strictEqual(res.sidebar.expanded.storedSidebar, "false", "expand persists");
    assert.strictEqual(res.sidebar.shortcut.sidebarCollapsed, true, "Cmd+B collapses the sidebar");

    // Popup dismissal and menu destinations.
    assert.strictEqual(res.popup.outside.popupOpen, false, "click outside closes the popup");
    assert.strictEqual(res.popup.esc.popupOpen, false, "Esc closes the popup");
    assert.strictEqual(res.menu.sentinel.view, "viewSentinel", "Sentinel menu item switches view");
    assert.strictEqual(res.menu.sentinel.hash, "#sentinel", "Sentinel deep link is written");
    assert.strictEqual(res.menu.sentinel.popupOpen, false, "Sentinel item closes the popup");
    assert.strictEqual(res.menu.settings.view, "viewSettings", "Settings menu item switches view");
    assert.strictEqual(res.menu.settings.hash, "#settings", "Settings deep link is written");
    assert.strictEqual(res.clear.storedSession, null, "Clear History resets the active session key");
    assert.strictEqual(res.clear.popupOpen, false, "Clear History closes the popup");

    // Shortcuts and Esc precedence.
    assert.strictEqual(res.shortcuts.detail.detailOpen, true, "Cmd+I opens the detail panel");
    assert.strictEqual(res.shortcuts.detailEsc.detailOpen, false, "Esc closes the detail panel");
    assert.strictEqual(res.shortcuts.canvas.canvasOpen, true, "Cmd+Shift+A opens the canvas state");
    assert.strictEqual(res.shortcuts.canvasEsc.canvasOpen, false, "Esc closes the canvas");
    assert.strictEqual(res.shortcuts.escPrecedence.popupOpen, false, "Esc closes the popup first");
    assert.strictEqual(res.shortcuts.escPrecedence.detailOpen, true, "Esc leaves the detail panel behind the popup open");

    console.log("[proof] account real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
