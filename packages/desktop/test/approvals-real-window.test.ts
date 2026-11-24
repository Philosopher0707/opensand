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

const shotDir = process.env.OPENSAND_APPROVALS_SHOT_DIR || "";
const TIMEOUT_MS = Number(process.env.OPENSAND_APPROVALS_TIMEOUT_MS || 90000);

const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, TIMEOUT_MS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 120)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 150; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
const waitLong = async (fn) => { for (let i = 0; i < 110; i++) { await sleep(300); if (await js("Boolean(" + fn + ")")) return; } throw new Error("wait timed out: " + fn); };

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
      await wait("document.querySelector('#inboxSection') && document.body.classList.contains('is-electron')");

      const bridge = globalThis.__opensandDesktopApp?.bridge || globalThis.__opensandBridge;
      if (!bridge) throw new Error("DesktopBridge not exposed on globalThis");

      const result = {
        initialEmpty: false,
        renderedPending: false,
        sizes: {},
        detailViewMetrics: {},
        approveOnceResolution: false,
        rejectResolution: false,
        alwaysAllowResolution: false,
        backendStates: {},
        inlineCard: {},
        cardSizes: {},
        inlineEditApprove: {},
        stale: {},
        malformed: {},
        timeout: {},
        cancelled: {},
        keyboard: {},
      };

      // 1. Check initial empty state
      await wait("document.querySelector('.inbox-empty-title')");
      const initialBadge = await js("document.querySelector('.inbox-badge-count')?.textContent?.trim()");
      result.initialEmpty = (initialBadge === "0");

      // A. Inline card in chat: payload, two viewports, edit + approve, both surfaces clear.
      await js("(() => { delete window.__testApproveTool; return true; })()");
      const inlinePromise = bridge.requestApproval(
        "exec_command",
        { command: "echo inline" },
        "Inline card check"
      );
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      result.inlineCard = {
        tool: await js("document.querySelector('#approvalCardToolName')?.textContent?.trim()"),
        summary: await js("document.querySelector('.approval-card-summary')?.textContent?.includes('echo inline')"),
        status: await js("document.querySelector('.chat-status span')?.textContent?.includes('Approval needed')"),
        buttons: await js("Boolean(document.querySelector('#btnApproveInChat') && document.querySelector('#btnEditApproveInChat') && document.querySelector('#btnDenyInChat'))"),
        aria: await js("document.querySelector('.approval-card')?.getAttribute('aria-label')"),
      };
      for (const [width, height, tag] of [[960, 740, "compact"], [1920, 1080, "wide"]]) {
        win.setContentSize(width, height);
        await sleep(400);
        result.cardSizes[tag] = await js("(() => { const c = document.querySelector('.approval-card'); const r = c && c.getBoundingClientRect(); return { visible: Boolean(r && r.width > 0 && r.height > 0), noOverflow: document.documentElement.scrollWidth <= window.innerWidth, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }; })()");
      }
      await shot("inline-approval-card");
      win.setContentSize(960, 740);
      await js("document.querySelector('#btnEditApproveInChat').click()");
      await waitLong("document.querySelector('#approvalCardArgs')?.tagName === 'TEXTAREA'");
      await js("(() => { const t = document.querySelector('#approvalCardArgs'); t.value = JSON.stringify({ command: 'echo edited' }); t.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await sleep(120);
      await js("document.querySelector('#btnApproveInChat').click()");
      const inlineResolved = await inlinePromise;
      await waitLong("!document.querySelector('.approval-card')");
      result.inlineEditApprove = {
        resolved: inlineResolved === true,
        inboxCleared: (await js("document.querySelector('.inbox-badge-count')?.textContent?.trim()")) === "0",
        pendingCleared: (await bridge.listPendingApprovals()).length === 0,
      };

      // B. Stale epoch (409): plain message; the card stays open for a retry.
      const stalePromise = bridge.requestApproval("exec_command", { command: "echo stale" }, "Stale check");
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      await sleep(400);
      await js("(() => { window.__staleCalls = 0; window.__testApproveTool = () => { window.__staleCalls++; return Promise.reject({ code: 4001, name: 'StaleEpochError', message: 'stale epoch' }); }; return true; })()");
      await js("document.querySelector('#btnApproveInChat').click()");
      await waitLong("document.querySelector('.approval-card-error')");
      result.stale = {
        message: await js("document.querySelector('.approval-card-error')?.textContent?.trim()"),
        calls: await js("window.__staleCalls"),
        cardStillOpen: await js("Boolean(document.querySelector('.approval-card'))"),
      };
      await js("(() => { delete window.__testApproveTool; return true; })()");
      await js("document.querySelector('#btnDenyInChat').click()");
      await stalePromise;
      await waitLong("!document.querySelector('.approval-card')");

      // C. Malformed edited args: inline validation, no send.
      const malformedPromise = bridge.requestApproval("write_file", { path: "src/x.txt", content: "hello" }, "Bad args check");
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      await js("(() => { window.__approveCalls = 0; window.__testApproveTool = () => { window.__approveCalls++; return Promise.reject(new Error('should not be called')); }; return true; })()");
      await js("document.querySelector('#btnEditApproveInChat').click()");
      await waitLong("document.querySelector('#approvalCardArgs')?.tagName === 'TEXTAREA'");
      await js("(() => { const t = document.querySelector('#approvalCardArgs'); t.value = '{ not json'; t.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await js("document.querySelector('#btnApproveInChat').click()");
      await waitLong("document.querySelector('.approval-card-error')?.textContent?.includes('Nothing was sent')");
      result.malformed = {
        message: await js("document.querySelector('.approval-card-error')?.textContent?.trim()"),
        notSent: (await js("window.__approveCalls")) === 0,
        cardStillOpen: await js("Boolean(document.querySelector('.approval-card'))"),
      };
      await js("(() => { delete window.__testApproveTool; return true; })()");
      await js("document.querySelector('#btnDenyInChat').click()");
      await malformedPromise;
      await waitLong("!document.querySelector('.approval-card')");

      // D. An answer that never arrives: the 15s guard gives a plain timeout message.
      const timeoutPromise = bridge.requestApproval("exec_command", { command: "echo slow" }, "Timeout check");
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      await js("(() => { window.__testApproveTool = () => new Promise(() => {}); return true; })()");
      await js("document.querySelector('#btnApproveInChat').click()");
      await waitLong("document.querySelector('.approval-card-error')?.textContent?.includes('too long')");
      result.timeout = {
        message: await js("document.querySelector('.approval-card-error')?.textContent?.trim()"),
        cardStillOpen: await js("Boolean(document.querySelector('.approval-card'))"),
      };
      await js("(() => { delete window.__testApproveTool; return true; })()");
      await js("document.querySelector('#btnDenyInChat').click()");
      await timeoutPromise;
      await waitLong("!document.querySelector('.approval-card')");

      // E. Turn cancelled with the card open: card closes, status says cancelled.
      const cancelPromise = bridge.requestApproval("exec_command", { command: "echo cancel" }, "Cancel check");
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      bridge.emitEvent("turn_cancelled", { message: "Turn cancelled by user." });
      await waitLong("!document.querySelector('.approval-card')");
      result.cancelled = {
        status: await js("document.querySelector('.chat-status span')?.textContent?.trim()"),
      };
      for (const pending of await bridge.listPendingApprovals()) {
        await js("window.opensand.approveTool(" + JSON.stringify(pending.approvalId) + ", { action: 'reject', epoch: " + pending.epoch + " })");
      }
      await cancelPromise;

      // F. Keyboard: Enter on the focused card approves; Esc from the composer does not deny.
      const keyboardPromise = bridge.requestApproval("exec_command", { command: "echo keyboard" }, "Keyboard check");
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      await js("(() => { const c = document.querySelector('.approval-card'); if (c) c.focus(); return Boolean(c); })()");
      const enterSent = await js("(() => { const c = document.querySelector('.approval-card'); if (c) c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return Boolean(c); })()");
      await sleep(500);
      const keyboardResolved = await Promise.race([keyboardPromise, sleep(6000).then(() => "timeout")]);
      await waitLong("!document.querySelector('.approval-card')");
      result.keyboard.enterApproved = keyboardResolved === true;

      const escPromise = bridge.requestApproval("exec_command", { command: "echo esc" }, "Esc check");
      await wait("document.querySelector('.approval-card')");
      await sleep(300);
      await js("document.querySelector('#promptInput').focus()");
      await js("document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
      await sleep(200);
      result.keyboard.composerEscIgnored = await js("Boolean(document.querySelector('.approval-card'))");
      await js("(() => { const c = document.querySelector('.approval-card'); if (c) c.focus(); return Boolean(c); })()");
      await js("(() => { const c = document.querySelector('.approval-card'); if (c) c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return Boolean(c); })()");
      const escResolved = await Promise.race([escPromise, sleep(6000).then(() => "timeout")]);
      await waitLong("!document.querySelector('.approval-card')");
      result.keyboard.cardEscDenied = escResolved === false;

      // The card phases above leave no pending approvals; clear any straggler before the Inbox flow.
      for (const pending of await bridge.listPendingApprovals()) {
        await js("window.opensand.approveTool(" + JSON.stringify(pending.approvalId) + ", { action: 'reject', epoch: " + pending.epoch + " })");
      }
      await wait("document.querySelector('.inbox-empty-title')");

      // 2. Request Approval 1 on backend bridge (exec_command)
      const approval1Promise = bridge.requestApproval(
        "exec_command",
        { command: "pnpm test --filter @opensand/desktop" },
        "Run test suite for desktop package"
      );

      // Wait for pending approval to appear in Preact UI
      await wait("document.querySelector('#inboxSection .inbox-item')");
      const badgeAfterRequest = await js("document.querySelector('.inbox-badge-count')?.textContent?.trim()");
      const itemAsking = await js("document.querySelector('#inboxSection .inbox-item-asking')?.textContent?.trim()");
      const itemWants = await js("document.querySelector('#inboxSection .inbox-item-wants')?.textContent?.trim()");
      result.renderedPending = (badgeAfterRequest === "1" && itemAsking === "exec_command" && itemWants.includes("pnpm test"));

      // 3. Click the item in sidebar #inboxSection to open detail view in main panel
      await js("document.querySelector('#inboxSection .inbox-item').click()");
      await wait("document.querySelector('.approval-detail-view')");

      const detailTool = await js("document.querySelector('#approvalDetailToolName')?.textContent?.trim()");
      const detailReason = await js("document.querySelector('#approvalDetailReason')?.textContent?.trim()");
      const detailArgs = await js("document.querySelector('#approvalDetailArgsBox')?.textContent?.trim()");
      const hasBtnApprove = await js("Boolean(document.querySelector('#btnApproveOnce'))");
      const hasBtnAlways = await js("Boolean(document.querySelector('#btnAlwaysAllow'))");
      const hasBtnReject = await js("Boolean(document.querySelector('#btnRejectTool'))");

      result.detailViewMetrics = {
        tool: detailTool,
        reason: detailReason,
        hasArgs: detailArgs.includes("pnpm test"),
        hasBtnApprove,
        hasBtnAlways,
        hasBtnReject,
      };

      // 4. Test Viewport Layout & Responsiveness at 960x740 and 1920x1080 with zero horizontal overflow
      const SIZES = [[960, 740, "compact"], [1920, 1080, "wide"]];
      for (const [width, height, tag] of SIZES) {
        win.setContentSize(width, height);
        await sleep(400);

        const metrics = await js("(() => {\n" +
          "const detail = document.querySelector('.approval-detail-view');\n" +
          "const card = document.querySelector('.approval-detail-card');\n" +
          "const btnApprove = document.querySelector('#btnApproveOnce');\n" +
          "const btnAlways = document.querySelector('#btnAlwaysAllow');\n" +
          "const btnReject = document.querySelector('#btnRejectTool');\n" +
          "const cr = card ? card.getBoundingClientRect() : null;\n" +
          "return {\n" +
            "detailPresent: Boolean(detail),\n" +
            "cardVisible: cr ? (cr.width > 0 && cr.height > 0) : false,\n" +
            "hasAllButtons: Boolean(btnApprove && btnAlways && btnReject),\n" +
            "noOverflow: document.documentElement.scrollWidth <= window.innerWidth,\n" +
            "scrollWidth: document.documentElement.scrollWidth,\n" +
            "innerWidth: window.innerWidth,\n" +
          "};\n" +
        "})()");

        await shot("approvals-" + tag + "-" + width + "x" + height);
        result.sizes[tag] = metrics;
      }

      // 5. Execute Decision: Approve Once via #btnApproveOnce
      await js("document.querySelector('#btnApproveOnce').click()");
      const approval1ResolvedVal = await approval1Promise;
      await wait("!document.querySelector('.approval-detail-view')");
      await wait("document.querySelector('.inbox-empty-title')");
      await shot("approvals-approved-once-resolved");

      const badgeAfterApproval1 = await js("document.querySelector('.inbox-badge-count')?.textContent?.trim()");
      const backendPendingAfter1 = await bridge.listPendingApprovals();
      result.approveOnceResolution = (approval1ResolvedVal === true && badgeAfterApproval1 === "0" && backendPendingAfter1.length === 0);

      // 6. Test Decision: Reject via expanded sidebar item
      const approval2Promise = bridge.requestApproval(
        "write_file",
        { path: "src/secret-keys.env" },
        "Write environment secrets"
      );
      await wait("document.querySelector('#inboxSection .inbox-item')");
      // Click item to expand details in sidebar
      await js("document.querySelector('#inboxSection .inbox-item').click()");
      await wait("document.querySelector('.inbox-item-details')");

      // Click reject button in the sidebar item's decision row
      await js("document.querySelector('.inbox-item-details button[data-action=\"reject\"]').click()");
      const approval2ResolvedVal = await approval2Promise;
      await wait("!document.querySelector('.approval-detail-view')");
      await wait("document.querySelector('.inbox-empty-title')");
      await shot("approvals-rejected-resolved");

      const badgeAfterApproval2 = await js("document.querySelector('.inbox-badge-count')?.textContent?.trim()");
      const backendPendingAfter2 = await bridge.listPendingApprovals();
      result.rejectResolution = (approval2ResolvedVal === false && badgeAfterApproval2 === "0" && backendPendingAfter2.length === 0);

      // 7. Test Decision: Always Allow via main detail view
      const approval3Promise = bridge.requestApproval(
        "exec_command",
        { command: "git status --porcelain" },
        "Check git status"
      );
      await wait("document.querySelector('#inboxSection .inbox-item')");
      await js("document.querySelector('#inboxSection .inbox-item').click()");
      await wait("document.querySelector('.approval-detail-view')");

      await js("document.querySelector('#btnAlwaysAllow').click()");
      const approval3ResolvedVal = await approval3Promise;
      await wait("!document.querySelector('.approval-detail-view')");
      await wait("document.querySelector('.inbox-empty-title')");
      await shot("approvals-always-allow-resolved");

      const badgeAfterApproval3 = await js("document.querySelector('.inbox-badge-count')?.textContent?.trim()");
      const backendPendingAfter3 = await bridge.listPendingApprovals();
      result.alwaysAllowResolution = (approval3ResolvedVal === true && badgeAfterApproval3 === "0" && backendPendingAfter3.length === 0);

      result.backendStates = {
        finalPendingCount: backendPendingAfter3.length,
      };

      console.log("__APPROVALS_REAL_WINDOW_RESULT__:" + JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
      process.exit(0);
    } catch (err) {
      console.error("[approvals runner] error", err);
      clearTimeout(timeout);
      app.quit();
      process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

test("Preact Approvals UI real-window test at 960x740 and 1920x1080", async (t) => {
  const reason = skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const home = makeTempHome("opensand-approvals-home-");
  const ws = makeTempHome("opensand-approvals-ws-");
  fs.writeFileSync(path.join(ws, "README.md"), "# Approvals Test Workspace\n", "utf8");

  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-approvals-harness-"));
  const runner = path.join(tmpDir, "runner-approvals.mjs");
  fs.writeFileSync(runner, RUNNER_SCRIPT, "utf8");

  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-approvals-proofs-"));

  const env = hermeticElectronEnv(home);
  env.OPENSAND_RENDERER = "preact";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_APPROVALS_SHOT_DIR = proofDir;

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

    assert.strictEqual(code, 0, `approvals runner failed (${code})\n${stdout}\n${stderr}`);
    const match = stdout.match(/__APPROVALS_REAL_WINDOW_RESULT__:(.*)/);
    assert.ok(match, `no result in stdout:\n${stdout}\n${stderr}`);
    const res = JSON.parse(match[1]);

    // Initial state check
    assert.strictEqual(res.initialEmpty, true, "initial inbox state is empty with badge 0");

    // Pending approval rendering from bridge/IPC
    assert.strictEqual(res.renderedPending, true, "pending approval renders in inbox with correct tool & summary");

    // Inline card: visible at both sizes, editable, and one answer clears both surfaces.
    assert.strictEqual(res.inlineCard.tool, "exec_command", "card shows the tool name");
    assert.strictEqual(res.inlineCard.summary, true, "card shows a plain command summary");
    assert.strictEqual(res.inlineCard.status, true, "status no longer sends the user to the Inbox");
    assert.strictEqual(res.inlineCard.buttons, true, "card has Approve, Edit & approve and Deny");
    assert.ok(String(res.inlineCard.aria).includes("exec_command"), "card has an aria label");
    for (const tag of ["compact", "wide"]) {
      const c = res.cardSizes[tag];
      assert.ok(c, `${tag} card metrics present`);
      assert.strictEqual(c.visible, true, `${tag} card visible`);
      assert.strictEqual(c.noOverflow, true, `${tag} zero horizontal overflow (${c.scrollWidth} <= ${c.innerWidth})`);
    }
    assert.strictEqual(res.inlineEditApprove.resolved, true, "edited approval resolves through the bridge");
    assert.strictEqual(res.inlineEditApprove.inboxCleared, true, "chat decision clears the Inbox badge");
    assert.strictEqual(res.inlineEditApprove.pendingCleared, true, "chat decision clears the backend queue");

    // Four failure paths, each in plain words, none losing the card.
    assert.strictEqual(res.stale.calls, 1, "stale answer reached the approve path");
    assert.ok(String(res.stale.message).includes("changed"), "stale epoch gets a plain message");
    assert.strictEqual(res.stale.cardStillOpen, true, "stale answer keeps the card open");
    assert.ok(String(res.malformed.message).includes("Nothing was sent"), "malformed args get inline validation");
    assert.strictEqual(res.malformed.notSent, true, "malformed args are never sent");
    assert.strictEqual(res.malformed.cardStillOpen, true, "malformed args keep the card open");
    assert.ok(String(res.timeout.message).includes("too long"), "timeout gets a plain message");
    assert.strictEqual(res.timeout.cardStillOpen, true, "timeout keeps the card open");
    assert.ok(String(res.cancelled.status).toLowerCase().includes("cancelled"), "cancel closes the card with a cancelled message");
    assert.strictEqual(res.keyboard.enterApproved, true, "Enter on the focused card approves");
    assert.strictEqual(res.keyboard.composerEscIgnored, true, "Esc in the composer leaves the card open");
    assert.strictEqual(res.keyboard.cardEscDenied, true, "Esc on the focused card denies");

    // Detail view metrics
    assert.strictEqual(res.detailViewMetrics.tool, "exec_command", "detail view shows tool name");
    assert.ok(res.detailViewMetrics.reason.includes("Run test suite"), "detail view shows request reason");
    assert.strictEqual(res.detailViewMetrics.hasArgs, true, "detail view shows formatted arguments");
    assert.strictEqual(res.detailViewMetrics.hasBtnApprove, true, "detail view has #btnApproveOnce");
    assert.strictEqual(res.detailViewMetrics.hasBtnAlways, true, "detail view has #btnAlwaysAllow");
    assert.strictEqual(res.detailViewMetrics.hasBtnReject, true, "detail view has #btnRejectTool");

    // Compact 960x740 layout and zero horizontal overflow
    const compact = res.sizes.compact;
    assert.ok(compact, "compact 960x740 metrics present");
    assert.strictEqual(compact.detailPresent, true, "detail view present at 960x740");
    assert.strictEqual(compact.cardVisible, true, "detail card visible at 960x740");
    assert.strictEqual(compact.hasAllButtons, true, "all 3 action buttons present at 960x740");
    assert.strictEqual(compact.noOverflow, true, `zero horizontal overflow at 960x740 (${compact.scrollWidth} <= ${compact.innerWidth})`);

    // Wide 1920x1080 layout and zero horizontal overflow
    const wide = res.sizes.wide;
    assert.ok(wide, "wide 1920x1080 metrics present");
    assert.strictEqual(wide.detailPresent, true, "detail view present at 1920x1080");
    assert.strictEqual(wide.cardVisible, true, "detail card visible at 1920x1080");
    assert.strictEqual(wide.hasAllButtons, true, "all 3 action buttons present at 1920x1080");
    assert.strictEqual(wide.noOverflow, true, `zero horizontal overflow at 1920x1080 (${wide.scrollWidth} <= ${wide.innerWidth})`);

    // Decision execution updating backend state
    assert.strictEqual(res.approveOnceResolution, true, "Approve Once executes via IPC with epoch, clears UI & resolves backend true");
    assert.strictEqual(res.rejectResolution, true, "Reject executes via IPC, clears UI & resolves backend false");
    assert.strictEqual(res.alwaysAllowResolution, true, "Always Allow executes via IPC with epoch, clears UI & resolves backend true");
    assert.strictEqual(res.backendStates.finalPendingCount, 0, "final backend pending approvals queue is empty");

    console.log("[proof] approvals real-window screenshots written to:", proofDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
