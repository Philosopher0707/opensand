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
import { makeGitWorkspace, trustFolderIn } from "./engine-mission-fixture.js";

// Real Electron window test: verifies historical turn reconstruction in Preact shell.
// Stored session turns from disk (transcript.jsonl / transcript.txt) hydrate on session
// selection and render correctly in #messageFeed at both 960x740 (minimum) and 1920x1080 (full screen).
const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "..", "..");
const shotDir = process.env.OPENSAND_CHAT_SHOT_DIR || path.join(repoRoot, ".opensand-snapshots", "chat-history");
const SIZES: Array<[number, number, string]> = [
  [960, 740, "960x740"],
  [1920, 1080, "1920x1080"],
];

const HIST_USER_QUERY = "What is the primary color of the sky?";
const HIST_ASSISTANT_ANSWER = "The sky is primarily blue.";

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

const RUNNER_SCRIPT = [
  'import { app } from "electron";',
  'import fs from "node:fs";',
  'import path from "node:path";',
  'const shotDir = process.env.OPENSAND_CHAT_SHOT_DIR || "";',
  'const SIZES = JSON.parse(process.env.OPENSAND_CHAT_SIZES || "[]");',
  'const TARGET_SESSION_ID = process.env.OPENSAND_TARGET_SESSION_ID || "sess-hist-1";',
  'const TIMEOUT_MS = Number(process.env.OPENSAND_CHAT_TIMEOUT_MS || 120000);',
  '',
  'const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);',
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'let win;',
  'const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 90)); throw e; });',
  'const wait = async (fn) => { for (let i = 0; i < 150; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };',
  '',
  'async function shot(label) {',
  '  if (!shotDir) return;',
  '  fs.mkdirSync(shotDir, { recursive: true });',
  '  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");',
  '  await sleep(250);',
  '  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());',
  '}',
  '',
  'const METRICS = "(() => { " +',
  '  "const root = document.querySelector(\'.chat-view\'); " +',
  '  "const feed = document.querySelector(\'#messageFeed\'); " +',
  '  "const input = document.querySelector(\'#promptInput\'); " +',
  '  "const sr = root ? root.getBoundingClientRect() : null; " +',
  '  "const ir = input ? input.getBoundingClientRect() : null; " +',
  '  "const assistantBubbles = feed ? [...feed.querySelectorAll(\'.message-assistant .chat-text\')].map((e) => e.textContent.trim()) : []; " +',
  '  "const userBubbles = feed ? [...feed.querySelectorAll(\'.message-user .chat-text\')].map((e) => e.textContent.trim()) : []; " +',
  '  "return { " +',
  '    "status: root ? root.dataset.status : null, " +',
  '    "screen: root ? root.dataset.state : null, " +',
  '    "emptyHint: !!document.querySelector(\'.chat-empty\'), " +',
  '    "userText: userBubbles.join(\'\\\\n\'), " +',
  '    "answer: assistantBubbles.join(\'\\\\n\'), " +',
  '    "messageCount: feed ? feed.querySelectorAll(\'.message\').length : 0, " +',
  '    "inViewport: sr ? (sr.width > 0 && sr.height > 0 && sr.top >= 0 && sr.bottom <= window.innerHeight) : false, " +',
  '    "inputInViewport: ir ? (ir.width > 0 && ir.top >= 0 && ir.bottom <= window.innerHeight) : false, " +',
  '    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth " +',
  '  "}; " +',
  '"})()";',
  '',
  'app.on("browser-window-created", (_e, w) => {',
  '  win = w;',
  '  w.webContents.on("did-finish-load", async () => {',
  '    try {',
  '      await wait("document.querySelector(\'#promptInput\') && document.body.classList.contains(\'is-electron\')");',
  '      await wait("document.querySelectorAll(\'.session-channel-item\').length > 0");',
  '',
  '      const result = { sizes: {} };',
  '',
  '      for (const [w, h, tag] of SIZES) {',
  '        win.setContentSize(w, h);',
  '        await sleep(400);',
  '',
  '        const clicked = await js("(() => { const items = [...document.querySelectorAll(\'.session-channel-item\')]; const item = items.find((el) => el.getAttribute(\'data-session-id\') === " + JSON.stringify(TARGET_SESSION_ID) + ") || items[0]; if (item) { item.click(); return true; } return false; })()");',
  '        if (!clicked) throw new Error("Could not find session item for " + TARGET_SESSION_ID);',
  '',
  '        await wait("document.querySelectorAll(\'#messageFeed .message\').length >= 2");',
  '        await wait("document.querySelector(\'#messageFeed .message-assistant .chat-text\')");',
  '',
  '        await sleep(300);',
  '        const m = await js(METRICS);',
  '        await shot(tag + "-history");',
  '        result.sizes[tag] = m;',
  '      }',
  '',
  '      console.log("__RESULT__:" + JSON.stringify(result));',
  '      clearTimeout(timeout);',
  '      app.quit();',
  '      process.exit(0);',
  '    } catch (err) {',
  '      console.error("[runner] error", err);',
  '      clearTimeout(timeout);',
  '      app.quit();',
  '      process.exit(1);',
  '    }',
  '  });',
  '});',
  'await import(process.env.OPENSAND_MAIN);',
].join("\n");

test("real Electron window hydrates and renders stored session turns at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const sessionId = "sess-hist-1";
  const home = makeTempHome("opensand-chat-history-home-");
  const ws = makeGitWorkspace({ "README.md": "# Chat History Test" });
  await trustFolderIn(home, ws);

  // Seed stored session transcript
  const sessDir = path.join(home, ".opensand", "sessions", sessionId);
  fs.mkdirSync(sessDir, { recursive: true });
  const jsonl = [
    JSON.stringify({ role: "user", content: HIST_USER_QUERY }),
    JSON.stringify({ role: "assistant", content: HIST_ASSISTANT_ANSWER }),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(sessDir, "transcript.jsonl"), jsonl, "utf8");
  fs.writeFileSync(
    path.join(sessDir, "transcript.txt"),
    `<user_query>\n${HIST_USER_QUERY}\n</user_query>\nassistant:\n${HIST_ASSISTANT_ANSWER}\n`,
    "utf8"
  );

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-hist-harness-"));
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const env = hermeticElectronEnv(home);
  delete env.OPENSAND_RENDERER;
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_CHAT_SHOT_DIR = shotDir;
  env.OPENSAND_CHAT_SIZES = JSON.stringify(SIZES);
  env.OPENSAND_TARGET_SESSION_ID = sessionId;

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

    assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const result = JSON.parse(match[1]);

    for (const [w, h, tag] of SIZES) {
      const m = result.sizes[tag];
      assert.ok(m, `missing results for size ${tag}`);
      assert.strictEqual(m.noOverflow, true, `${tag}: no horizontal overflow`);
      assert.strictEqual(m.inViewport, true, `${tag}: chat view inside viewport`);
      assert.strictEqual(m.emptyHint, false, `${tag}: empty hint hidden after hydration`);
      assert.strictEqual(m.screen, "ready", `${tag}: screen state is ready`);
      assert.strictEqual(m.status, "idle", `${tag}: chat status is idle`);
      assert.ok(m.messageCount >= 2, `${tag}: at least 2 messages rendered in feed`);
      assert.ok(m.userText.includes(HIST_USER_QUERY), `${tag}: user text matches historical query`);
      assert.ok(m.answer.includes(HIST_ASSISTANT_ANSWER), `${tag}: assistant text matches historical answer`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
