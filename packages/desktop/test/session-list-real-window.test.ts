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

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

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
  '',
  'const shotDir = process.env.OPENSAND_SESSION_LIST_SHOT_DIR || "";',
  'const TIMEOUT_MS = Number(process.env.OPENSAND_SESSION_LIST_TIMEOUT_MS || 90000);',
  '',
  'const timeout = setTimeout(() => {',
  '  console.error("[runner] timeout");',
  '  app.quit();',
  '  process.exit(1);',
  '}, TIMEOUT_MS);',
  '',
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'let win;',
  'const js = (code) =>',
  '  win.webContents.executeJavaScript(code).catch((e) => {',
  '    console.error("[js failed] " + String(code).slice(0, 120));',
  '    throw e;',
  '  });',
  '',
  'const wait = async (fn) => {',
  '  for (let i = 0; i < 150; i++) {',
  '    if (await js("Boolean(" + fn + ")")) return;',
  '    await sleep(100);',
  '  }',
  '  throw new Error("wait timed out: " + fn);',
  '};',
  '',
  'async function shot(label) {',
  '  if (!shotDir) return;',
  '  fs.mkdirSync(shotDir, { recursive: true });',
  '  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");',
  '  await sleep(250);',
  '  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());',
  '}',
  '',
  'let loadPhase = 0;',
  'const testResult = {',
  '  initialRendering: false,',
  '  badgeChecks: {},',
  '  searchAndEmptyPassed: false,',
  '  selectionAndHydrationPassed: false,',
  '  sizes: {},',
  '  brandResetPassed: false,',
  '  deletionPassed: false,',
  '  persistenceReloadPassed: false,',
  '};',
  '',
  'app.on("browser-window-created", (_e, w) => {',
  '  win = w;',
  '  w.webContents.on("did-finish-load", async () => {',
  '    try {',
  '      loadPhase++;',
  '',
  '      if (loadPhase === 1) {',
  '        await wait("document.querySelector(\'#sessionList\') && document.body.classList.contains(\'is-electron\')");',
  '        await wait("document.querySelectorAll(\'#sessionList .session-channel-item\').length === 3");',
  '',
  '        const bridge = globalThis.__opensandDesktopApp?.bridge || globalThis.__opensandBridge;',
  '        if (!bridge) throw new Error("DesktopBridge not exposed on globalThis");',
  '',
  '        console.log("[test step 1] initial rendering and badge checks");',
  '        const initialBadgeData = await js("(() => {" +',
  '          "const items = [...document.querySelectorAll(\'#sessionList .session-channel-item\')];" +',
  '          "const findBadge = (id) => {" +',
  '            "const el = items.find((it) => it.getAttribute(\'data-session-id\') === id);" +',
  '            "return el ? el.querySelector(\'.channel-unread-badge\')?.textContent?.trim() || null : null;" +',
  '          "};" +',
  '          "return {" +',
  '            "count: items.length," +',
  '            "alphaBadge: findBadge(\'sess-alpha\')," +',
  '            "betaBadge: findBadge(\'sess-beta\')," +',
  '            "gammaBadge: findBadge(\'sess-gamma\')," +',
  '            "activeTitle: document.querySelector(\'#activeSessionTitle\')?.textContent?.trim()," +',
  '          "};" +',
  '        "})()");',
  '',
  '        testResult.initialRendering = (initialBadgeData.count === 3 && initialBadgeData.activeTitle === "New Session");',
  '        testResult.badgeChecks = initialBadgeData;',
  '',
  '        console.log("[test step 2] search filtering and empty state");',
  '        await js("(() => {" +',
  '          "const input = document.querySelector(\'#conversationSearchInput\');" +',
  '          "input.value = \'Beta\';" +',
  '          "input.dispatchEvent(new Event(\'input\', { bubbles: true }));" +',
  '        "})()");',
  '        await wait("document.querySelectorAll(\'#sessionList .session-channel-item\').length === 1");',
  '        const filteredToBeta = await js("(() => {" +',
  '          "const item = document.querySelector(\'#sessionList .session-channel-item\');" +',
  '          "return item ? item.getAttribute(\'data-session-id\') === \'sess-beta\' : false;" +',
  '        "})()");',
  '',
  '        await js("(() => {" +',
  '          "const input = document.querySelector(\'#conversationSearchInput\');" +',
  '          "input.value = \'NonExistentXYZ\';" +',
  '          "input.dispatchEvent(new Event(\'input\', { bubbles: true }));" +',
  '        "})()");',
  '        await wait("document.querySelector(\'#sessionList .roster-empty\')");',
  '        const emptyStateText = await js("(() => {" +',
  '          "const title = document.querySelector(\'.roster-empty-title\')?.textContent?.trim();" +',
  '          "const desc = document.querySelector(\'.roster-empty-desc\')?.textContent?.trim();" +',
  '          "return { title, desc };" +',
  '        "})()");',
  '',
  '        await js("(() => {" +',
  '          "const input = document.querySelector(\'#conversationSearchInput\');" +',
  '          "input.value = \'\';" +',
  '          "input.dispatchEvent(new Event(\'input\', { bubbles: true }));" +',
  '        "})()");',
  '        await wait("document.querySelectorAll(\'#sessionList .session-channel-item\').length === 3");',
  '',
  '        testResult.searchAndEmptyPassed =',
  '          filteredToBeta &&',
  '          emptyStateText.title === "No conversations match" &&',
  '          emptyStateText.desc.includes("NonExistentXYZ");',
  '',
  '        console.log("[test step 3] session selection, title update, badge clear, transcript hydration");',
  '        await js("(() => {" +',
  '          "const item = [...document.querySelectorAll(\'#sessionList .session-channel-item\')].find(" +',
  '            "(it) => it.getAttribute(\'data-session-id\') === \'sess-alpha\'" +',
  '          ");" +',
  '          "item.click();" +',
  '        "})()");',
  '',
  '        await wait("document.querySelector(\'#sessionList .session-channel-item.active\')?.getAttribute(\'data-session-id\') === \'sess-alpha\'");',
  '        await wait("document.querySelector(\'#activeSessionTitle\')?.textContent?.trim() === \'Alpha Project\'");',
  '        await wait("document.querySelectorAll(\'#messageFeed .chat-message, #messageFeed .message\').length >= 2 || document.querySelector(\'#messageFeed .chat-text\')");',
  '',
  '        const alphaPostClick = await js("(() => {" +',
  '          "const item = [...document.querySelectorAll(\'#sessionList .session-channel-item\')].find(" +',
  '            "(it) => it.getAttribute(\'data-session-id\') === \'sess-alpha\'" +',
  '          ");" +',
  '          "const badge = item ? item.querySelector(\'.channel-unread-badge\') : null;" +',
  '          "const feedText = document.querySelector(\'#messageFeed\')?.textContent || \'\';" +',
  '          "return {" +',
  '            "badgeCleared: badge === null," +',
  '            "hasTranscript: feedText.includes(\'Alpha is the primary initiative.\')," +',
  '            "activeTitle: document.querySelector(\'#activeSessionTitle\')?.textContent?.trim()," +',
  '            "savedSessionId: localStorage.getItem(\'opensand-session-id\')," +',
  '          "};" +',
  '        "})()");',
  '',
  '        testResult.selectionAndHydrationPassed =',
  '          alphaPostClick.badgeCleared &&',
  '          alphaPostClick.hasTranscript &&',
  '          alphaPostClick.activeTitle === "Alpha Project" &&',
  '          alphaPostClick.savedSessionId === "sess-alpha";',
  '',
  '        console.log("[test step 4] window layout at 960x740 and 1920x1080");',
  '        const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];',
  '        for (const [width, height, tag] of SIZES) {',
  '          win.setContentSize(width, height);',
  '          await sleep(400);',
  '',
  '          const metrics = await js("(() => {" +',
  '            "const list = document.querySelector(\'#sessionList\');" +',
  '            "const feed = document.querySelector(\'#messageFeed\');" +',
  '            "const activeItem = document.querySelector(\'.session-channel-item.active\');" +',
  '            "const titleEl = document.querySelector(\'#activeSessionTitle\');" +',
  '            "const lr = list ? list.getBoundingClientRect() : null;" +',
  '            "return {" +',
  '              "listPresent: Boolean(list)," +',
  '              "listVisible: lr ? (lr.width > 0 && lr.height > 0) : false," +',
  '              "hasActiveItem: Boolean(activeItem)," +',
  '              "activeTitle: titleEl ? titleEl.textContent.trim() : \'\'," +',
  '              "noOverflow: document.documentElement.scrollWidth <= window.innerWidth," +',
  '              "scrollWidth: document.documentElement.scrollWidth," +',
  '              "innerWidth: window.innerWidth," +',
  '              "};" +',
  '          "})()");',
  '',
  '          await shot("session-list-" + tag + "-" + width + "x" + height);',
  '          testResult.sizes[tag] = metrics;',
  '        }',
  '',
  '        console.log("[test step 5] brand home button reset");',
  '        await js("document.querySelector(\'#brandHomeBtn\').click()");',
  '        await wait("document.querySelector(\'#activeSessionTitle\')?.textContent?.trim() === \'New Session\'");',
  '        await wait("document.querySelector(\'#messageFeed .chat-empty\')");',
  '',
  '        const brandResetData = await js("(() => {" +',
  '          "return {" +',
  '            "title: document.querySelector(\'#activeSessionTitle\')?.textContent?.trim()," +',
  '            "savedId: localStorage.getItem(\'opensand-session-id\')," +',
  '            "hasNoActiveItem: document.querySelectorAll(\'.session-channel-item.active\').length === 0," +',
  '            "hasEmptyChat: Boolean(document.querySelector(\'#messageFeed .chat-empty\'))," +',
  '          "};" +',
  '        "})()");',
  '',
  '        testResult.brandResetPassed =',
  '          brandResetData.title === "New Session" &&',
  '          brandResetData.savedId === null &&',
  '          brandResetData.hasNoActiveItem &&',
  '          brandResetData.hasEmptyChat;',
  '',
  '        console.log("[test step 6] deletion handling");',
  '        await js("(() => {" +',
  '          "const item = [...document.querySelectorAll(\'#sessionList .session-channel-item\')].find(" +',
  '            "(it) => it.getAttribute(\'data-session-id\') === \'sess-gamma\'" +',
  '          ");" +',
  '          "item.click();" +',
  '        "})()");',
  '        await wait("document.querySelector(\'#activeSessionTitle\')?.textContent?.trim() === \'Gamma Exploration\'");',
  '',
  '        // Click delete, then the inline confirm (no blocking dialog)',
  '        await js("(() => {" +',
  '          "const item = [...document.querySelectorAll(\'#sessionList .session-channel-item\')].find(" +',
  '            "(it) => it.getAttribute(\'data-session-id\') === \'sess-gamma\'" +',
  '          ");" +',
  '          "const btnDel = item.querySelector(\'.btn-delete-session\');" +',
  '          "btnDel.click();" +',
  '        "})()");',
  '        await wait("document.querySelector(\'#sessionList .delete-confirm button\')")',
  '        await js("document.querySelector(\'#sessionList .delete-confirm button\').click()")',
  '',
  '        await wait("document.querySelectorAll(\'#sessionList .session-channel-item\').length === 2");',
  '        await wait("document.querySelector(\'#activeSessionTitle\')?.textContent?.trim() === \'New Session\'");',
  '',
  '        const backendSessionsAfterDelete = await bridge.getSessions();',
  '        const deletedFromBackend = !backendSessionsAfterDelete.some((s) => s.id === "sess-gamma");',
  '',
  '        const deleteUiState = await js("(() => {" +',
  '          "return {" +',
  '            "itemCount: document.querySelectorAll(\'#sessionList .session-channel-item\').length," +',
  '            "title: document.querySelector(\'#activeSessionTitle\')?.textContent?.trim()," +',
  '            "savedId: localStorage.getItem(\'opensand-session-id\')," +',
  '          "};" +',
  '        "})()");',
  '',
  '        testResult.deletionPassed =',
  '          deletedFromBackend &&',
  '          deleteUiState.itemCount === 2 &&',
  '          deleteUiState.title === "New Session" &&',
  '          deleteUiState.savedId === null;',
  '',
  '        console.log("[test step 7] reload persistence");',
  '        await js("(() => {" +',
  '          "const item = [...document.querySelectorAll(\'#sessionList .session-channel-item\')].find(" +',
  '            "(it) => it.getAttribute(\'data-session-id\') === \'sess-beta\'" +',
  '          ");" +',
  '          "item.click();" +',
  '        "})()");',
  '        await wait("document.querySelector(\'#activeSessionTitle\')?.textContent?.trim() === \'Beta Analysis\'");',
  '        await wait("localStorage.getItem(\'opensand-session-id\') === \'sess-beta\'");',
  '',
  '        // Trigger reload',
  '        await win.webContents.reload();',
  '      } else if (loadPhase === 2) {',
  '        console.log("[test step 8] post-reload verification");',
  '        await wait("document.querySelector(\'#sessionList\') && document.body.classList.contains(\'is-electron\')");',
  '        await wait("document.querySelectorAll(\'#sessionList .session-channel-item\').length === 2");',
  '        await wait("document.querySelector(\'#activeSessionTitle\')?.textContent?.trim() === \'Beta Analysis\'");',
  '        await wait("document.querySelector(\'#sessionList .session-channel-item.active\')?.getAttribute(\'data-session-id\') === \'sess-beta\'");',
  '        await wait("document.querySelector(\'#messageFeed\')?.textContent?.includes(\'Beta testing is proceeding.\')");',
  '',
  '        await shot("session-list-restored-after-reload");',
  '',
  '        const restoredData = await js("(() => {" +',
  '          "return {" +',
  '            "activeTitle: document.querySelector(\'#activeSessionTitle\')?.textContent?.trim()," +',
  '            "activeItemId: document.querySelector(\'#sessionList .session-channel-item.active\')?.getAttribute(\'data-session-id\')," +',
  '            "feedHasBetaText: document.querySelector(\'#messageFeed\')?.textContent?.includes(\'Beta testing is proceeding.\')," +',
  '            "savedId: localStorage.getItem(\'opensand-session-id\')," +',
  '          "};" +',
  '        "})()");',
  '',
  '        testResult.persistenceReloadPassed =',
  '          restoredData.activeTitle === "Beta Analysis" &&',
  '          restoredData.activeItemId === "sess-beta" &&',
  '          restoredData.feedHasBetaText &&',
  '          restoredData.savedId === "sess-beta";',
  '',
  '        console.log("__SESSION_LIST_REAL_WINDOW_RESULT__:" + JSON.stringify(testResult));',
  '        clearTimeout(timeout);',
  '        app.quit();',
  '        process.exit(0);',
  '      }',
  '    } catch (err) {',
  '      console.error("[runner error]", err);',
  '      clearTimeout(timeout);',
  '      app.quit();',
  '      process.exit(1);',
  '    }',
  '  });',
  '});',
  '',
  'await import(process.env.OPENSAND_MAIN);',
].join("\n");

test("Preact Sessions list real-window test: search, selection, hydration, unread badges, persistence, deletion at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-session-list-home-");
  const stateDir = path.join(home, ".opensand");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({
      endpoint: "http://localhost:1234/v1/chat/completions",
      model: "test-model",
      apiKey: "sk-test-session-key",
    }),
    "utf8"
  );
  const ws = makeGitWorkspace({ "README.md": "# Session List Test" });
  await trustFolderIn(home, ws);

  // Seed sessions
  const sessions = [
    {
      id: "sess-alpha",
      title: "Alpha Project",
      unreadCount: 3,
      userPrompt: "Tell me about Alpha",
      assistantResponse: "Alpha is the primary initiative.",
    },
    {
      id: "sess-beta",
      title: "Beta Analysis",
      unreadCount: 0,
      userPrompt: "How is Beta doing?",
      assistantResponse: "Beta testing is proceeding.",
    },
    {
      id: "sess-gamma",
      title: "Gamma Exploration",
      unreadCount: 1,
      userPrompt: "Explore Gamma options",
      assistantResponse: "Gamma exploration commenced.",
    },
  ];

  for (const s of sessions) {
    const sessDir = path.join(home, ".opensand", "sessions", s.id);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "meta.json"),
      JSON.stringify({ title: s.title, unreadCount: s.unreadCount }),
      "utf8"
    );
    const jsonl = [
      JSON.stringify({ role: "user", content: s.userPrompt }),
      JSON.stringify({ role: "assistant", content: s.assistantResponse }),
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(sessDir, "transcript.jsonl"), jsonl, "utf8");
    fs.writeFileSync(
      path.join(sessDir, "transcript.txt"),
      `<user_query>\n${s.userPrompt}\n</user_query>\nassistant:\n${s.assistantResponse}\n`,
      "utf8"
    );
  }

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-session-list-harness-"));
  const runner = path.join(tmpDir, "runner-session-list.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-session-list-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_STATE_DIR = stateDir;
  env.OPENSAND_SESSION_LIST_SHOT_DIR = proofDir;

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
        process.stdout.write(d);
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
        process.stderr.write(d);
      });
      return whenElectronExited(child);
    });

    assert.strictEqual(code, 0, `session-list runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__SESSION_LIST_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    // Initial rendering & badges
    assert.strictEqual(res.initialRendering, true, "sessions render in list and initial title is 'New Session'");
    assert.strictEqual(res.badgeChecks.alphaBadge, "3", "sess-alpha has unread badge '3'");
    assert.strictEqual(res.badgeChecks.betaBadge, null, "sess-beta has no unread badge (0)");
    assert.strictEqual(res.badgeChecks.gammaBadge, "1", "sess-gamma has unread badge '1'");

    // Search and empty state
    assert.strictEqual(res.searchAndEmptyPassed, true, "search filters session list and shows match/empty state correctly");

    // Selection, title, badge clearing, transcript hydration
    assert.strictEqual(res.selectionAndHydrationPassed, true, "session selection clears unread badge, sets title, hydrates messages, and sets active class");

    // Viewport layout at 960x740 and 1920x1080
    const compact = res.sizes.compact;
    assert.ok(compact, "compact 960x740 metrics present");
    assert.strictEqual(compact.listPresent, true, "session list present at 960x740");
    assert.strictEqual(compact.listVisible, true, "session list visible at 960x740");
    assert.strictEqual(compact.hasActiveItem, true, "active session highlighted at 960x740");
    assert.strictEqual(compact.noOverflow, true, `zero horizontal overflow at 960x740 (${compact.scrollWidth} <= ${compact.innerWidth})`);

    const wide = res.sizes.wide;
    assert.ok(wide, "wide 1920x1080 metrics present");
    assert.strictEqual(wide.listPresent, true, "session list present at 1920x1080");
    assert.strictEqual(wide.listVisible, true, "session list visible at 1920x1080");
    assert.strictEqual(wide.hasActiveItem, true, "active session highlighted at 1920x1080");
    assert.strictEqual(wide.noOverflow, true, `zero horizontal overflow at 1920x1080 (${wide.scrollWidth} <= ${wide.innerWidth})`);

    // Brand button reset
    assert.strictEqual(res.brandResetPassed, true, "brand home button clears active session, clears localStorage, and resets message feed");

    // Deletion
    assert.strictEqual(res.deletionPassed, true, "deleting active session removes from UI, resets active title to 'New Session', and clears localStorage");

    // Persistence across reload
    assert.strictEqual(res.persistenceReloadPassed, true, "selected session persists to localStorage and restores active state, title, and transcript on reload");

    // Copy proof screenshots to external proof directory if available
    const defaultProofDir = path.join(os.homedir(), "dev/_scratch/proof-logs/session-list");
    const externalProofDir = process.env.PROOF_DIR || defaultProofDir;
    try {
      fs.mkdirSync(externalProofDir, { recursive: true });
      for (const f of fs.readdirSync(proofDir)) {
        fs.copyFileSync(path.join(proofDir, f), path.join(externalProofDir, f));
      }
      console.log("[proof] session-list real-window screenshots written to:", externalProofDir);
    } catch {
      // In CI environments without scratch directories, screenshots stay in temporary proofDir
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
