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

const shotDir = process.env.OPENSAND_NAV_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_NAV_TIMEOUT_MS || 90000);

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

const SNAPSHOT = (label) => "(() => {\n" +
  "const vis = (sel) => { const el = document.querySelector(sel); return Boolean(el) && !el.classList.contains('hidden') && el.offsetParent !== null; };\n" +
  "const activeNav = Array.from(document.querySelectorAll('.footer-nav-btn.active')).map((b) => b.id);\n" +
  "const panel = document.querySelector('.view-panel:not(.hidden)');\n" +
  "return {\n" +
    "label: " + JSON.stringify(label) + ",\n" +
    "hash: window.location.hash,\n" +
    "search: window.location.search,\n" +
    "title: document.querySelector('#viewHeaderTitle')?.textContent?.trim() || '',\n" +
    "backVisible: vis('#btnBackToChat'),\n" +
    "activeNav,\n" +
    "activePanelId: panel ? panel.id : null,\n" +
    "subnavCount: panel ? panel.querySelectorAll('.subnav-tab').length : 0,\n" +
    "activeSubnav: panel ? Array.from(panel.querySelectorAll('.subnav-tab.active')).map((b) => b.dataset.view) : [],\n" +
    "subnavVisible: (() => { if (!panel) return true; const r = panel.getBoundingClientRect(); const tabs = Array.from(panel.querySelectorAll('.subnav-tab')); return tabs.every((t) => { const b = t.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; }); })(),\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('.main-panel').scrollWidth <= document.querySelector('.main-panel').clientWidth,\n" +
    "panelNoOverflow: panel ? panel.scrollWidth <= panel.clientWidth : false,\n" +
  "};\n" +
"})()";

let phase = 0;
// The renderer reloads for the query-param check; the main process keeps this object.
const result = { sizes: {}, initial: null, footer: {}, subnav: {}, back: null, hashLink: null, queryLink: null };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    phase += 1;
    try {
      if (phase === 1) {
        await wait("document.querySelector('#navBtnBots') && document.body.classList.contains('is-electron')");

        result.initial = await js(SNAPSHOT("initial"));

        for (const [w2, h2, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
          win.setContentSize(w2, h2);
          await sleep(400);
          result.sizes[tag] = await js(SNAPSHOT("chat-" + tag));
          await shot("nav-chat-" + tag + "-" + w2 + "x" + h2);
        }

        // Footer navigation: Bots
        await js("document.querySelector('#navBtnBots').click()");
        await wait("document.querySelector('#viewTemplates') && !document.querySelector('#viewTemplates').classList.contains('hidden')");
        result.footer.bots = await js(SNAPSHOT("bots"));

        // Footer navigation: Capabilities
        await js("document.querySelector('#navBtnCapabilities').click()");
        await wait("!document.querySelector('#viewSkills').classList.contains('hidden')");
        result.footer.capabilities = await js(SNAPSHOT("capabilities"));

        // Subnav inside Capabilities: skills -> routines -> vault -> memories
        result.subnav.steps = [];
        for (const view of ["routines", "vault", "memories"]) {
          await js("document.querySelector('#viewSkills .subnav-tab[data-view=\"" + view + "\"]').click()");
          await wait("!document.querySelector('#view" + view.charAt(0).toUpperCase() + view.slice(1) + "').classList.contains('hidden')");
          result.subnav.steps.push(await js(SNAPSHOT(view)));
        }

        // Footer navigation: Connections, then a stub view at both sizes
        await js("document.querySelector('#navBtnConnections').click()");
        await wait("!document.querySelector('#viewBoundaries').classList.contains('hidden')");
        result.footer.connections = await js(SNAPSHOT("connections"));

        for (const [w2, h2, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
          win.setContentSize(w2, h2);
          await sleep(400);
          await js("document.querySelector('#viewBoundaries .subnav-tab[data-view=\"graphs\"]').click()");
          await wait("!document.querySelector('#viewGraphs').classList.contains('hidden')");
          result.sizes["graphs-" + tag] = await js(SNAPSHOT("graphs-" + tag));
          await shot("nav-graphs-" + tag + "-" + w2 + "x" + h2);
        }

        // Back to chat
        await js("document.querySelector('#btnBackToChat').click()");
        await wait("!document.querySelector('#viewChat').classList.contains('hidden')");
        result.back = await js(SNAPSHOT("back"));

        // Hash deep link (hashchange while mounted)
        await navigateToView({ js, sleep }, "graphs", "#viewGraphs");
        result.hashLink = await js(SNAPSHOT("hash-graphs"));

        // Query-param deep link: reload with ?view=sentinel, checked in phase 2
        try {
          await js("history.replaceState({}, '', '?view=sentinel'); location.reload();");
        } catch {}
        return;
      }

      // phase 2: page reloaded with ?view=sentinel
      await wait("document.querySelector('#viewSentinel') && document.body.classList.contains('is-electron')");
      result.queryLink = await js(SNAPSHOT("query-sentinel"));
      await shot("nav-query-sentinel");
      console.log("__NAV_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[nav runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});

await import(process.env.OPENSAND_MAIN);
`;

test("Preact navigation footer and view switching real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-nav-home-");
  const ws = makeTempHome("opensand-nav-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Navigation Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-nav-harness-"));
  const runner = path.join(tmpDir, "runner-nav.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-nav-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_NAV_SHOT_DIR = proofDir;

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

    assert.strictEqual(code, 0, `nav runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__NAV_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    // Initial view
    assert.strictEqual(res.initial.activePanelId, "viewChat", "default view is chat");
    assert.strictEqual(res.initial.title, "Chat & Dialogue", "chat header title");
    assert.strictEqual(res.initial.backVisible, false, "back-to-chat hidden on chat");
    assert.deepStrictEqual(res.initial.activeNav, [], "no footer nav active on chat");
    assert.strictEqual(res.initial.subnavCount, 0, "chat has no subnav");

    // Footer navigation
    assert.strictEqual(res.footer.bots.activePanelId, "viewTemplates", "Bots opens templates");
    assert.strictEqual(res.footer.bots.hash, "#templates", "Bots writes #templates");
    assert.strictEqual(res.footer.bots.title, "Bots & Personas", "Bots header title");
    assert.deepStrictEqual(res.footer.bots.activeNav, ["navBtnBots"], "Bots button active");
    assert.strictEqual(res.footer.bots.backVisible, true, "back-to-chat visible off chat");
    assert.strictEqual(res.footer.bots.subnavCount, 2, "templates group has 2 tabs");

    assert.strictEqual(res.footer.capabilities.activePanelId, "viewSkills", "Capabilities opens skills");
    assert.strictEqual(res.footer.capabilities.hash, "#skills", "Capabilities writes #skills");
    assert.strictEqual(res.footer.capabilities.title, "Modular Recipe Skills Library", "Capabilities header title");
    assert.deepStrictEqual(res.footer.capabilities.activeNav, ["navBtnCapabilities"], "Capabilities button active");
    assert.strictEqual(res.footer.capabilities.subnavCount, 4, "capabilities group has 4 tabs");

    // Subnav switching
    const steps = res.subnav.steps;
    assert.strictEqual(steps.length, 3, "three subnav steps recorded");
    assert.strictEqual(steps[0].activePanelId, "viewRoutines", "subnav opens routines");
    assert.deepStrictEqual(steps[0].activeSubnav, ["routines"], "routines tab active");
    assert.strictEqual(steps[0].title, "Scheduled Background Routines", "routines header title");
    assert.strictEqual(steps[0].hash, "#routines", "routines writes #routines");
    assert.deepStrictEqual(steps[0].activeNav, ["navBtnCapabilities"], "footer stays on Capabilities");
    assert.strictEqual(steps[1].activePanelId, "viewVault", "subnav opens vault");
    assert.strictEqual(steps[2].activePanelId, "viewMemories", "subnav opens memories");

    assert.strictEqual(res.footer.connections.activePanelId, "viewBoundaries", "Connections opens boundaries");
    assert.strictEqual(res.footer.connections.hash, "#boundaries", "Connections writes #boundaries");
    assert.strictEqual(res.footer.connections.subnavCount, 6, "connections group has 6 tabs");

    // Back to chat
    assert.strictEqual(res.back.activePanelId, "viewChat", "back returns to chat");
    assert.strictEqual(res.back.hash, "#chat", "back writes #chat");
    assert.strictEqual(res.back.backVisible, false, "back-to-chat hides on chat");
    assert.deepStrictEqual(res.back.activeNav, [], "no footer nav active on chat");

    // Hash deep link
    assert.strictEqual(res.hashLink.activePanelId, "viewGraphs", "#graphs opens graphs");
    assert.strictEqual(res.hashLink.title, "Agent Graphs & Cyclical Loops", "#graphs header title");
    assert.deepStrictEqual(res.hashLink.activeNav, ["navBtnConnections"], "#graphs keeps Connections active");

    // Query deep link (after reload)
    assert.strictEqual(res.queryLink.activePanelId, "viewSentinel", "?view=sentinel opens sentinel");
    assert.strictEqual(res.queryLink.title, "Workspace Sentinel & Self-Healing", "?view=sentinel header title");
    assert.strictEqual(res.queryLink.search, "?view=sentinel", "query preserved");
    assert.deepStrictEqual(res.queryLink.activeNav, [], "sentinel has no footer group, matching legacy");
    assert.strictEqual(res.queryLink.subnavCount, 0, "sentinel has no subnav tabs");

    // Layout at both sizes, chat and a stub view
    for (const tag of ["compact", "wide"]) {
      const chat = res.sizes[tag];
      assert.ok(chat, `${tag} chat metrics present`);
      assert.strictEqual(chat.noOverflow, true, `zero horizontal overflow on chat at ${tag}`);
      assert.strictEqual(chat.panelNoOverflow, true, `chat panel has zero horizontal overflow at ${tag}`);
      const graphs = res.sizes["graphs-" + tag];
      assert.ok(graphs, `${tag} graphs metrics present`);
      assert.strictEqual(graphs.noOverflow, true, `zero horizontal overflow on graphs at ${tag}`);
      assert.strictEqual(graphs.panelNoOverflow, true, `graphs panel has zero horizontal overflow at ${tag}`);
      assert.strictEqual(graphs.activePanelId, "viewGraphs", `graphs panel active at ${tag}`);
      assert.strictEqual(graphs.subnavVisible, true, `all 6 connection subnav tabs fit at ${tag}`);
    }

    console.log("[proof] navigation real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
