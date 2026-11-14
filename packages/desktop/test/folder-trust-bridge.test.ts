import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StaleEpochError } from '@opensand/shared';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

const bridges: DesktopIpcBridge[] = [];
const tmpDirs: string[] = [];

// Real bridge, hermetic temp HOME and temp workspace: nothing touches the owner's ~/.opensand.
function makeBridge(opts: { autoApprove?: boolean; link?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-trust-bridge-'));
  tmpDirs.push(home);
  const real = path.join(home, 'project');
  fs.mkdirSync(real);
  let workspaceDir = real;
  if (opts.link) {
    workspaceDir = path.join(home, 'link-to-project');
    fs.symlinkSync(real, workspaceDir);
  }
  const bridge = new DesktopIpcBridge({ baseDir: path.join(home, '.opensand'), workspaceDir });
  bridge.updateSettings({ autoApprove: opts.autoApprove ?? false, model: 'test-folder-trust' });
  bridges.push(bridge);
  return { bridge, real: fs.realpathSync.native(real) };
}

test.afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

// Poll until the trust question is open; a fixed sleep is flaky when other packages' tests run alongside.
async function pending(bridge: DesktopIpcBridge) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const list = await bridge.listPendingApprovals();
    if (list.length > 0 || Date.now() > deadline) return list;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('folder trust - session is held before any coordinator exists', async () => {
  const { bridge, real } = makeBridge();
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  assert.strictEqual(req.toolName, 'folder.trust');
  assert.strictEqual((req.args as { folder: string }).folder, real);
  assert.strictEqual(bridge.getCoordinator(), null, 'no coordinator while the question is open');
  await bridge.approveTool(req.approvalId, { action: 'reject', epoch: req.epoch });
  await built;
});

test('folder trust - autoApprove never answers the trust question', async () => {
  const { bridge } = makeBridge({ autoApprove: true });
  const built = bridge.createSessionCoordinator('s1');
  const list = await pending(bridge);
  assert.strictEqual(list.length, 1, 'still pending with autoApprove on');
  assert.strictEqual(list[0].toolName, 'folder.trust');
  await bridge.approveTool(list[0].approvalId, { action: 'reject', epoch: list[0].epoch });
  await built;
});

test('folder trust - always_allow persists trusted and builds a workspace-write coordinator', async () => {
  const { bridge, real } = makeBridge();
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  assert.deepStrictEqual(await bridge.approveTool(req.approvalId, { action: 'always_allow', epoch: req.epoch }), { success: true });
  const coordinator = await built;
  assert.strictEqual(coordinator.sandboxProfile, 'workspace-write');
  assert.strictEqual(await bridge.getFolderTrust(real), 'trusted');
});

test('folder trust - reject persists untrusted and builds a read-only coordinator', async () => {
  const { bridge, real } = makeBridge();
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  await bridge.approveTool(req.approvalId, { action: 'reject', epoch: req.epoch });
  const coordinator = await built;
  assert.strictEqual(coordinator.sandboxProfile, 'read-only');
  assert.strictEqual(await bridge.getFolderTrust(real), 'untrusted');
});

test('folder trust - approve_once trusts this bridge only and persists nothing', async () => {
  const { bridge, real } = makeBridge();
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  await bridge.approveTool(req.approvalId, { action: 'approve_once', epoch: req.epoch });
  assert.strictEqual((await built).sandboxProfile, 'workspace-write');
  assert.strictEqual(await bridge.getFolderTrust(real), 'prompt');
});

test('folder trust - lowering trust while the question is pending makes the answer stale (4001)', async () => {
  const { bridge, real } = makeBridge();
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  await bridge.setFolderTrust(real, 'trusted');
  await bridge.setFolderTrust(real, 'untrusted'); // lowering: epoch bump
  await assert.rejects(
    bridge.approveTool(req.approvalId, { action: 'always_allow', epoch: req.epoch }),
    (err: unknown) => err instanceof StaleEpochError,
  );
  // fail closed: the stale question resolves unanswered, the stored level is untouched
  const coordinator = await built;
  assert.strictEqual(coordinator.sandboxProfile, 'read-only');
  assert.strictEqual(await bridge.getFolderTrust(real), 'untrusted');
});

test('folder trust - an answer with no epoch is rejected 4001 and the question stays pending', async () => {
  const { bridge } = makeBridge();
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  await assert.rejects(
    bridge.approveTool(req.approvalId, { action: 'always_allow' } as never),
    (err: unknown) => err instanceof StaleEpochError,
  );
  assert.strictEqual((await bridge.listPendingApprovals()).length, 1);
  await bridge.approveTool(req.approvalId, { action: 'reject', epoch: req.epoch });
  await built;
});

test('folder trust - lowering drops the cached coordinator so the next turn re-derives its profile', async () => {
  const { bridge, real } = makeBridge();
  await bridge.setFolderTrust(real, 'trusted');
  const first = await bridge.createSessionCoordinator('s1');
  assert.strictEqual(first.sandboxProfile, 'workspace-write');
  assert.strictEqual(await bridge.createSessionCoordinator('s1'), first, 'cached while trust is unchanged');
  await bridge.setFolderTrust(real, 'untrusted');
  const second = await bridge.createSessionCoordinator('s1');
  assert.notStrictEqual(second, first);
  assert.strictEqual(second.sandboxProfile, 'read-only');
});

test('folder trust - a symlinked workspace is held under its real path', async () => {
  const { bridge, real } = makeBridge({ link: true });
  const built = bridge.createSessionCoordinator('s1');
  const [req] = await pending(bridge);
  assert.strictEqual((req.args as { folder: string }).folder, real);
  await bridge.approveTool(req.approvalId, { action: 'reject', epoch: req.epoch });
  await built;
});
