import { whenElectronExited } from "./helpers/electron-exit.js";
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";
import { git, makeGitWorkspace, runScriptedMission, trustFolderIn } from "./engine-mission-fixture.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultShotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-fork-shots-"));
const shotDir = process.env.OPENSAND_FORK_SHOT_DIR || defaultShotDir;

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  if (!fs.existsSync(path.join(pkgRoot, "dist", "renderer-next", "index.html"))) return "dist/renderer-next is not built";
  return undefined;
}

const RUNNER_HEAD = String.raw`
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
const shotDir = process.env.OPENSAND_FORK_SHOT_DIR || "";
const ws = process.env.OPENSAND_TEST_WORKSPACE;
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 50000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => { console.error("[js failed] " + String(code).slice(0, 90)); throw e; });
const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); } throw new Error("wait timed out: " + fn); };
async function shot(label) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(250);
  fs.writeFileSync(path.join(shotDir, label + ".png"), (await win.webContents.capturePage()).toPNG());
}
const disk = () => {
  const out = {};
  for (const f of ["file.txt", "extra.txt"]) { const p = path.join(ws, f); out[f] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null; }
  return out;
};
app.on("browser-window-created", (_e, w) => {
  win = w;
  w.webContents.on("did-finish-load", async () => {
    try {
      w.setContentSize(1280, 800);
      await sleep(600);
`;

const RUNNER_TAIL = String.raw`
      clearTimeout(timeout); app.quit(); process.exit(0);
    } catch (err) {
      console.error("[runner] error", err); clearTimeout(timeout); app.quit(); process.exit(1);
    }
  });
});
await import(process.env.OPENSAND_MAIN);
`;

const FORK_BODY = String.raw`
      const result = { exposed: await js("[typeof window.opensand.forkMission, typeof window.opensand.previewRestoreMissionSnapshot]") };
      result.before = disk();
      await wait("document.querySelector('.mission-item')");
      await js("document.querySelector('.mission-item').click()");
      await wait("document.querySelector('.btn-fork-step')");
      await shot("fork-timeline");

      // 1. Click Fork to trigger preview and show dialog
      await js("document.querySelector('.btn-fork-step').click()");
      await wait("document.querySelector('.btn-fork-confirm')");
      result.previewDialog = await js("Boolean(document.querySelector('.restore-preview-lists'))");
      result.previewDeletedCount = await js("document.querySelector('.badge-deleted')?.textContent || ''");
      result.previewOverwrittenCount = await js("document.querySelector('.badge-overwritten')?.textContent || ''");
      await shot("fork-dialog");

      // 2. Click Cancel: verify dialog closes and disk files remain unchanged
      await js("document.querySelector('.btn-fork-cancel').click()");
      await wait("!document.querySelector('.fork-dialog')");
      result.afterCancel = disk();

      // 3. Click Fork again, supply instruction, and confirm
      await js("document.querySelector('.btn-fork-step').click()");
      await wait("document.querySelector('.btn-fork-confirm')");
      await js("(() => { const t = document.querySelector('.fork-instruction-input'); if (t) { t.value = 'Alternate exploration'; t.dispatchEvent(new Event('input', { bubbles: true })); } })()");
      await sleep(100);
      await js("document.querySelector('.btn-fork-confirm').click()");
      await wait("!document.querySelector('.fork-dialog')");
      await sleep(600);
      result.afterFork = disk();
      result.toast = await js("document.querySelector('.restore-toast')?.textContent || ''");
      await shot("fork-created");
      console.log("__RESULT__:" + JSON.stringify(result));
`;

async function runElectron(body: string, opts: { renderer: "preact" | "legacy"; home: string; workspace: string }): Promise<any> {
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-fork-harness-"));
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER_HEAD + body + RUNNER_TAIL, "utf8");
  const env = hermeticElectronEnv(opts.home);
  env.OPENSAND_RENDERER = opts.renderer === "preact" ? "preact" : "legacy";
  env.OPENSAND_MAIN = path.join(pkgRoot, "dist", "src", "main.js");
  env.OPENSAND_TEST_WORKSPACE = opts.workspace;
  if (shotDir) env.OPENSAND_FORK_SHOT_DIR = shotDir;
  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], { cwd: opts.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return whenElectronExited(child);
    });
    assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
    const m = stdout.match(/__RESULT__:(.*)/);
    assert.ok(m, `no result in stdout:\n${stdout}\n${stderr}`);
    return JSON.parse(m[1]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function indexSha256(ws: string): string {
  const indexPath = path.join(ws, ".git", "index");
  if (!fs.existsSync(indexPath)) return "";
  return crypto.createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex");
}

test("Fork in the real window: a real mission is forked, workspace files restore to step 1, git index and stash byte-identical", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  const home = makeTempHome("opensand-fork-home-");
  const ws = makeGitWorkspace({ "file.txt": "initial" });
  try {
    // Add user stash BEFORE mission runs so it does not stash the mission's uncommitted files
    fs.writeFileSync(path.join(ws, "stash_candidate.txt"), "stash me\n");
    git(["stash", "push", "-u", "-m", "user stash"], ws);
    const beforeStashList = git(["stash", "list"], ws).trim();
    assert.ok(beforeStashList.length > 0, "stash entry exists before mission");

    const stateDir = path.join(home, ".opensand");
    trustFolderIn(stateDir, ws);
    await runScriptedMission(stateDir, ws, [
      { writes: { "file.txt": "step1", "extra.txt": "created by step 1" }, review: { accept: false, note: "again" } },
      { writes: { "file.txt": "step2" }, review: { accept: true, note: "ok" } },
    ]);
    assert.strictEqual(fs.readFileSync(path.join(ws, "file.txt"), "utf8"), "step2", "the mission changed the file");

    const beforeHead = git(["rev-parse", "HEAD"], ws).trim();
    const beforeBranch = git(["symbolic-ref", "HEAD"], ws).trim();
    const beforeIndexHash = indexSha256(ws);

    const r = await runElectron(FORK_BODY, { renderer: "preact", home, workspace: ws });

    assert.deepStrictEqual(r.exposed, ["function", "function"], "preload exposes forkMission and previewRestoreMissionSnapshot");
    assert.deepStrictEqual(r.before, { "file.txt": "step2", "extra.txt": "created by step 1" });
    assert.strictEqual(r.previewDialog, true, "the real Electron window rendered preview lists");
    assert.strictEqual(r.previewDeletedCount, "1", "preview shows 1 deleted file");
    assert.strictEqual(r.previewOverwrittenCount, "1", "preview shows 1 changed back file");
    assert.deepStrictEqual(r.afterCancel, r.before, "Cancel left workspace files completely unchanged on disk");
    assert.deepStrictEqual(r.afterFork, { "file.txt": "initial", "extra.txt": null }, "Fork restored workspace files to step 1");
    assert.ok(r.toast.includes("Forked"), `toast should announce fork: ${r.toast}`);

    // Verify Git invariants (§2 of timeline-fork.md)
    const afterHead = git(["rev-parse", "HEAD"], ws).trim();
    const afterBranch = git(["symbolic-ref", "HEAD"], ws).trim();
    const afterStashList = git(["stash", "list"], ws).trim();
    const afterIndexHash = indexSha256(ws);

    assert.strictEqual(afterHead, beforeHead, "HEAD ref strictly untouched");
    assert.strictEqual(afterBranch, beforeBranch, "Branch ref strictly untouched");
    assert.strictEqual(afterIndexHash, beforeIndexHash, "sha256(.git/index) strictly byte-identical");
    assert.strictEqual(afterStashList, beforeStashList, "git stash list strictly byte-identical");

    // Verify screenshot artifacts exist
    if (shotDir) {
      assert.ok(fs.existsSync(path.join(shotDir, "fork-timeline.png")), "fork-timeline.png exists");
      assert.ok(fs.existsSync(path.join(shotDir, "fork-dialog.png")), "fork-dialog.png exists");
      assert.ok(fs.existsSync(path.join(shotDir, "fork-created.png")), "fork-created.png exists");
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
