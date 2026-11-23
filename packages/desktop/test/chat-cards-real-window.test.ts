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

// Real Electron window test: verifies tool execution cards, thought accordion,
// and markdown rendering in Preact chat screen at 960x740 and 1920x1080 without overflow.
const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "..", "..");
const shotDir = process.env.OPENSAND_CHAT_SHOT_DIR || path.join(repoRoot, ".opensand-snapshots", "chat-cards");
const SIZES: Array<[number, number, string]> = [
  [960, 740, "960x740"],
  [1920, 1080, "1920x1080"],
];

const HIST_USER_QUERY = "Show me the project files and summarize them.";
const HIST_THOUGHT = "Analyzing project files and running command to inspect directory structure.";
const HIST_TOOL_NAME = "exec_command";
const HIST_TOOL_ARGS = { cmd: "ls -la" };
const HIST_TOOL_RESULT = "total 32\n-rw-r--r-- README.md\n-rw-r--r-- package.json";
const HIST_ASSISTANT_MD = [
  "### Workspace Inspection Summary",
  "",
  "Here are the **primary project files** discovered:",
  "",
  "- `README.md`: System architectural documentation",
  "- `package.json`: Dependencies and build configuration",
  "",
  "```json",
  "{",
  '  "name": "@opensand/desktop",',
  '  "version": "0.1.12"',
  "}",
  "```",
  "",
  "Visit the [OpenSand Portal](https://opensand.org) for more information.",
].join("\n");

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
  'const TARGET_SESSION_ID = process.env.OPENSAND_TARGET_SESSION_ID || "sess-cards-1";',
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
  '  "const thought = feed ? feed.querySelector(\'.thought-accordion\') : null; " +',
  '  "const toolLine = feed ? feed.querySelector(\'.tool-line\') : null; " +',
  '  "const toolBadge = toolLine ? toolLine.querySelector(\'.tool-line-badge\') : null; " +',
  '  "const codeWrapper = feed ? feed.querySelector(\'.code-block-wrapper\') : null; " +',
  '  "const heading = feed ? feed.querySelector(\'.chat-markdown h4, .chat-markdown h3, .chat-markdown h2\') : null; " +',
  '  "const list = feed ? feed.querySelector(\'.chat-markdown ul, .chat-markdown ol\') : null; " +',
  '  "const link = feed ? feed.querySelector(\'.chat-markdown a\') : null; " +',
  '  "return { " +',
  '    "status: root ? root.dataset.status : null, " +',
  '    "screen: root ? root.dataset.state : null, " +',
  '    "hasThought: !!thought, " +',
  '    "thoughtOpenDefault: thought ? thought.open : false, " +',
  '    "hasToolCard: !!toolLine, " +',
  '    "toolName: toolLine ? (toolLine.querySelector(\'.tool-line-label\')?.textContent || \'\') : \'\', " +',
  '    "toolBadge: toolBadge ? toolBadge.textContent : \'\', " +',
  '    "hasCodeBlock: !!codeWrapper, " +',
  '    "hasHeading: !!heading, " +',
  '    "hasList: !!list, " +',
  '    "hasLink: !!link, " +',
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
  '        await wait("document.querySelector(\'.thought-accordion\')");',
  '        await wait("document.querySelector(\'.tool-line\')");',
  '        await wait("document.querySelector(\'.code-block-wrapper\')");',
  '',
  '        // Test accordion toggling',
  '        await js("(() => { const t = document.querySelector(\'.thought-accordion summary\'); if (t) t.click(); })()");',
  '        await sleep(150);',
  '        const openedThought = await js("Boolean(document.querySelector(\'.thought-accordion\')?.open)");',
  '        await js("(() => { const t = document.querySelector(\'.thought-accordion summary\'); if (t) t.click(); })()");',
  '        await sleep(150);',
  '',
  '        const m = await js(METRICS);',
  '        m.accordionToggleWorks = openedThought;',
  '        await shot(tag + "-cards");',
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

test("real Electron window renders tool cards, thought accordion, and markdown at 960x740 and 1920x1080 without overflow", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const sessionId = "sess-cards-1";
  const home = makeTempHome("opensand-chat-cards-home-");
  const ws = makeGitWorkspace({ "README.md": "# Chat Cards Test" });
  await trustFolderIn(home, ws);

  // Seed stored session transcript with user query, thought block, tool execution, and markdown response
  const sessDir = path.join(home, ".opensand", "sessions", sessionId);
  fs.mkdirSync(sessDir, { recursive: true });
  const events = [
    { role: "user", content: HIST_USER_QUERY },
    {
      role: "assistant",
      thought: HIST_THOUGHT,
      content: HIST_ASSISTANT_MD,
      tool_calls: [
        {
          id: "call_ls_1",
          function: {
            name: HIST_TOOL_NAME,
            arguments: JSON.stringify(HIST_TOOL_ARGS),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_ls_1",
      result: HIST_TOOL_RESULT,
    },
  ];
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(path.join(sessDir, "transcript.jsonl"), jsonl, "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-chat-cards-harness-"));
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
      assert.strictEqual(m.screen, "ready", `${tag}: screen state is ready`);
      assert.strictEqual(m.status, "idle", `${tag}: chat status is idle`);
      assert.strictEqual(m.hasThought, true, `${tag}: thought accordion is rendered`);
      assert.strictEqual(m.thoughtOpenDefault, false, `${tag}: thought accordion is closed by default when turn is done`);
      assert.strictEqual(m.accordionToggleWorks, true, `${tag}: thought accordion toggles open on click`);
      assert.strictEqual(m.hasToolCard, true, `${tag}: tool card is rendered`);
      assert.strictEqual(m.toolName, HIST_TOOL_NAME, `${tag}: tool name matches`);
      assert.ok(m.toolBadge.toLowerCase().includes("done"), `${tag}: tool execution status is Done`);
      assert.strictEqual(m.hasCodeBlock, true, `${tag}: code block is rendered with wrapper`);
      assert.strictEqual(m.hasHeading, true, `${tag}: markdown heading is rendered`);
      assert.strictEqual(m.hasList, true, `${tag}: markdown list is rendered`);
      assert.strictEqual(m.hasLink, true, `${tag}: markdown link is rendered`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
