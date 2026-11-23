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

const shotDir = process.env.OPENSAND_ROOMS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_ROOMS_TIMEOUT_MS || 120000);
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 160)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 200; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const nativeSet = (sel, proto, value) => "(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); Object.getOwnPropertyDescriptor(" + proto + ".prototype, 'value').set.call(el, " + JSON.stringify(value) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
const setInput = (sel, value) => nativeSet(sel, "HTMLInputElement", value);
const setArea = (sel, value) => nativeSet(sel, "HTMLTextAreaElement", value);

async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}

const measure = () => js("(() => {\n" +
  "const q = (s) => document.querySelector(s);\n" +
  "const panel = q('#viewRooms');\n" +
  "const pr = panel ? panel.getBoundingClientRect() : null;\n" +
  "const tabs = Array.from(document.querySelectorAll('#viewRooms .subnav-tab'));\n" +
  "const gr = q('#roomsCardGrid') ? q('#roomsCardGrid').getBoundingClientRect() : null;\n" +
  "const cr = q('#roomsCardGrid .dashboard-card') ? q('#roomsCardGrid .dashboard-card').getBoundingClientRect() : null;\n" +
  "const modals = [q('#createRoomModal'), q('#conveneDiscussionModal')];\n" +
  "const openModal = modals.find((m) => m && !m.classList.contains('hidden'));\n" +
  "const mr = openModal && openModal.querySelector('.modal-card') ? openModal.querySelector('.modal-card').getBoundingClientRect() : null;\n" +
  "return {\n" +
    "innerWidth: window.innerWidth,\n" +
    "scrollWidth: document.documentElement.scrollWidth,\n" +
    "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
    "tabCount: tabs.length,\n" +
    "tabsFitPanel: pr ? tabs.every((t) => { const r = t.getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; }) : false,\n" +
    "gridFits: gr ? (gr.left >= -1 && gr.right <= window.innerWidth + 1) : false,\n" +
    "cardFits: cr ? (cr.left >= -1 && cr.right <= window.innerWidth + 1) : false,\n" +
    "modalOpen: Boolean(openModal),\n" +
    "modalCardFits: mr ? (mr.left >= -1 && mr.right <= window.innerWidth + 1 && mr.top >= -1 && mr.bottom <= window.innerHeight + 1) : false,\n" +
  "};\n" +
"})()");

const result = { emptyState: null, initialCards: null, checkboxes: null, validation: null, created: null, convened: null, sizes: { create: {}, convene: {} } };

app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      await wait("document.querySelector('#roomsCardGrid') && document.body.classList.contains('is-electron')");
      await navigateToView({ js, sleep }, "#rooms", "#viewRooms");
      await wait("!document.querySelector('#roomsCardGrid .rooms-loading')");

      // 1. Fresh state: the grid renders the empty state and no cards.
      result.emptyState = await js("document.querySelector('#roomsCardGrid .rooms-empty') ? document.querySelector('#roomsCardGrid .rooms-empty').textContent.trim() : ''");
      result.initialCards = await js("document.querySelectorAll('#roomsCardGrid .dashboard-card').length");
      await shot("rooms-empty-960x740");

      // 2. Stub only the room + agent routes so creation and deliberation are deterministic.
      await js("(() => {\n" +
        "const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json' } });\n" +
        "window.__rooms = [];\n" +
        "window.__agents = [{ id: 'a1', name: 'Ada', role: 'Architect', kind: 'AGENT' }, { id: 'a2', name: 'Dex', role: 'Engineer', kind: 'AGENT' }];\n" +
        "const orig = window.fetch.bind(window);\n" +
        "window.fetch = async (input, init) => {\n" +
          "const url = String(input && input.url ? input.url : input);\n" +
          "const method = (init && init.method) || 'GET';\n" +
          "if (url.includes('/api/agents')) return json(window.__agents);\n" +
          "if (url.includes('/api/rooms')) {\n" +
            "if (method === 'GET') return json(window.__rooms);\n" +
            "if (method === 'POST' && url.endsWith('/api/rooms')) {\n" +
              "const body = JSON.parse((init && init.body) || '{}');\n" +
              "const room = { roomId: 'room_test_1', name: body.name, description: body.description, memberAgentIds: body.memberAgentIds, discussionCount: 0 };\n" +
              "window.__rooms = [room];\n" +
              "return json(room, 201);\n" +
            "}\n" +
            "if (method === 'POST' && url.includes('/discuss')) return json({ roomId: 'room_test_1', consensus: 'Adopt the edge replication migration in two phases.', turns: [{ turnIndex: 1, memberName: 'Ada', memberRole: 'Architect', content: 'Phased rollout reduces risk.' }, { turnIndex: 2, memberName: 'Dex', memberRole: 'Engineer', content: 'Agreed, with a rollback plan.' }] });\n" +
          "}\n" +
          "return orig(input, init);\n" +
        "};\n" +
      "return true;\n" +
    "})()");

      // 3. Create modal: roster checkboxes load on open, empty name is rejected inline.
      await js("document.querySelector('#btnOpenCreateRoom').click()");
      await wait("!document.querySelector('#createRoomModal').classList.contains('hidden')");
      await wait("document.querySelectorAll('#roomMemberCheckboxes input[type=checkbox]').length === 2");
      result.checkboxes = await js("document.querySelectorAll('#roomMemberCheckboxes input[type=checkbox]').length");
      await js("document.querySelector('#btnSaveRoom').click()");
      await wait("document.querySelector('#roomFormError').textContent.includes('Please provide a room name')");
      result.validation = await js("document.querySelector('#roomFormError').textContent.trim()");

      // 4. A valid name creates the room and the card appears.
      await js(setInput('#roomName', 'Architecture Review Board'));
      await js(setArea('#roomDesc', 'Reviews high-impact changes'));
      await js("document.querySelector('#btnSaveRoom').click()");
      await wait("document.querySelectorAll('#roomsCardGrid .dashboard-card').length === 1");
      await wait("document.querySelector('#createRoomModal').classList.contains('hidden')");
      result.created = await js("({ name: document.querySelector('#roomsCardGrid .card-title').textContent.trim(), members: document.querySelector('#roomsCardGrid .badge-bot').textContent.trim(), desc: document.querySelector('#roomsCardGrid .card-desc').textContent.trim() })");
      await shot("rooms-card-created-960x740");

      // 5. Convene modal: topic -> deliberation renders both turns and the consensus.
      await js("document.querySelector('.btn-convene-room').click()");
      await wait("!document.querySelector('#conveneDiscussionModal').classList.contains('hidden')");
      result.conveneTitle = await js("document.querySelector('#conveneModalTitle').textContent.trim()");
      await js(setArea('#discussionTopic', 'Evaluate migrating the database layer to edge replication'));
      await js("document.querySelector('#btnStartDiscussion').click()");
      await wait("document.querySelectorAll('#discussionFeedBox .discussion-turn').length === 2");
      await wait("document.querySelector('#consensusBox').textContent.includes('Adopt the edge replication migration')");
      result.convened = await js("({ turns: document.querySelectorAll('#discussionFeedBox .discussion-turn').length, consensus: document.querySelector('#consensusBox').textContent.trim(), startHidden: document.querySelector('#btnStartDiscussion').classList.contains('hidden'), doneVisible: !document.querySelector('#btnCloseDiscussionDone').classList.contains('hidden'), resultsVisible: !document.querySelector('#discussionLiveResults').classList.contains('hidden') })");
      await shot("rooms-discussion-results-960x740");

      // 6. Responsive checks. State changes are done above and between loops, never inside a loop.
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.convene[tag] = await measure();
        await shot("rooms-convene-" + tag + "-" + width + "x" + height);
      }
      await js("document.querySelector('#btnCloseDiscussionDone').click()");
      await wait("document.querySelector('#conveneDiscussionModal').classList.contains('hidden')");

      await js("document.querySelector('#btnOpenCreateRoom').click()");
      await wait("!document.querySelector('#createRoomModal').classList.contains('hidden')");
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);
        result.sizes.create[tag] = await measure();
        await shot("rooms-create-" + tag + "-" + width + "x" + height);
      }

      console.log("__ROOMS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[rooms runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact rooms view, creation and deliberation modals at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-rooms-home-");
  const ws = makeTempHome("opensand-rooms-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Rooms Real Window Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-rooms-harness-"));
  const runner = path.join(tmpDir, "runner-rooms.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = process.env.OPENSAND_ROOMS_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "opensand-rooms-proofs-"));
  fs.mkdirSync(proofDir, { recursive: true });

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  // os.homedir() ignores HOME on macOS: the state dir must be explicit or the test touches live state.
  env.OPENSAND_STATE_DIR = path.join(home, ".opensand");
  env.OPENSAND_ROOMS_SHOT_DIR = proofDir;

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
      child.on("error", (err) => {
        stderr += String(err);
      });
      // A runner that fails to parse never emits "close" and would hang the suite silently.
      return new Promise<number>((resolve) => {
        let done = false;
        let watchdog: NodeJS.Timeout;
        const settle = (code: number) => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          resolve(code);
        };
        watchdog = setTimeout(() => { child.kill("SIGKILL"); settle(124); }, 180_000);
        void whenElectronExited(child).then(settle);
      });
    });

    assert.strictEqual(code, 0, `rooms runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__ROOMS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    assert.ok(res.emptyState.includes("No multi-agent rooms created yet."), `empty state renders (${JSON.stringify(res.emptyState)})`);
    assert.strictEqual(res.initialCards, 0, "fresh state has no room cards");
    assert.strictEqual(res.checkboxes, 2, "member persona checkboxes render on open");
    assert.strictEqual(res.validation, "Please provide a room name and select at least one member agent.", "empty name is rejected inline");
    assert.strictEqual(res.created.name, "Architecture Review Board", "created room card shows the name");
    assert.strictEqual(res.created.members, "2 Agents", "created room card shows the member badge");
    assert.strictEqual(res.created.desc, "Reviews high-impact changes", "created room card shows the description");
    assert.ok(res.conveneTitle.includes("Architecture Review Board"), `convene title names the room (${res.conveneTitle})`);
    assert.strictEqual(res.convened.turns, 2, "both round-table turns render");
    assert.ok(res.convened.consensus.includes("Adopt the edge replication migration"), "consensus verdict renders");
    assert.strictEqual(res.convened.startHidden, true, "start button hides once deliberation completes");
    assert.strictEqual(res.convened.doneVisible, true, "done close button appears once deliberation completes");
    assert.strictEqual(res.convened.resultsVisible, true, "live results are revealed");

    for (const kind of ["convene", "create"] as const) {
      for (const [tag, width, height] of [["compact", 960, 740], ["wide", 1920, 1080]] as const) {
        const size = res.sizes[kind][tag];
        assert.ok(size, `${kind} ${tag} ${width}x${height} metrics present`);
        assert.strictEqual(size.noOverflow, true, `${kind} ${tag}: zero horizontal overflow (${size.scrollWidth} <= ${size.innerWidth})`);
        assert.strictEqual(size.gridFits, true, `${kind} ${tag}: room grid fits the window`);
        assert.strictEqual(size.cardFits, true, `${kind} ${tag}: room card fits the window`);
        assert.strictEqual(size.tabCount, 6, `${kind} ${tag}: all six Connections tabs render`);
        assert.strictEqual(size.tabsFitPanel, true, `${kind} ${tag}: subnav tabs stay inside their panel`);
        assert.strictEqual(size.modalOpen, true, `${kind} ${tag}: ${kind} modal is open`);
        assert.strictEqual(size.modalCardFits, true, `${kind} ${tag}: ${kind} modal card fits the window`);
      }
    }

    console.log("[proof] rooms real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
