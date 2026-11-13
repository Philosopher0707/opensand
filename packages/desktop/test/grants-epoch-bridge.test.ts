import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge as BaseDesktopIpcBridge } from '../src/ipc-bridge.js';

const createdBridges: BaseDesktopIpcBridge[] = [];
const tmpDirs: string[] = [];

// Real bridge, hermetic temp HOME: nothing here touches the owner's ~/.opensand.
function makeBridge() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-grants-bridge-'));
  tmpDirs.push(home);
  const bridge = new BaseDesktopIpcBridge({ baseDir: path.join(home, '.opensand') });
  bridge.updateSettings({ autoApprove: false, model: 'test-grants-epoch' });
  createdBridges.push(bridge);
  return bridge;
}

test.afterEach(async () => {
  while (createdBridges.length) await createdBridges.pop()?.close();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

async function pendingIds(bridge: BaseDesktopIpcBridge): Promise<Array<{ approvalId: string; epoch: number }>> {
  await new Promise((r) => setTimeout(r, 10));
  return bridge.listPendingApprovals();
}

test('grants epoch - two approvals pending at the same epoch both succeed; epoch stays', async () => {
  const bridge = makeBridge();
  const a = bridge.requestUserApproval('exec_command', { command: 'git status' });
  const b = bridge.requestUserApproval('exec_command', { command: 'ls -la' });
  const [ra, rb] = await pendingIds(bridge);
  assert.strictEqual(ra.epoch, 1);
  assert.strictEqual(rb.epoch, 1);

  assert.deepStrictEqual(await bridge.approveTool(ra.approvalId, { action: 'always_allow', epoch: 1 }), { success: true });
  assert.strictEqual(await a, true);
  assert.strictEqual(bridge.grantsStore.getEpochSync(), 1, 'adding a grant must not bump the epoch');

  assert.deepStrictEqual(await bridge.approveTool(rb.approvalId, { action: 'approve_once', epoch: 1 }), { success: true });
  assert.strictEqual(await b, true);
  assert.strictEqual(bridge.grantsStore.getEpochSync(), 1);
  assert.strictEqual((await bridge.grantsStore.read()).grants.length, 1, 'only the always_allow stored a grant');
});

test('grants epoch - revoke while an approval is pending rejects the answer with StaleEpochError 4001', async () => {
  const bridge = makeBridge();
  const seed = bridge.requestUserApproval('exec_command', { command: 'git status' });
  const pending = bridge.requestUserApproval('exec_command', { command: 'npm test' });
  const [first, c] = await pendingIds(bridge);
  await bridge.approveTool(first.approvalId, { action: 'always_allow', epoch: 1 });
  assert.strictEqual(await seed, true);

  const [grant] = (await bridge.grantsStore.read()).grants;
  assert.deepStrictEqual(await bridge.revokeGrant(grant.id), { revoked: true, epoch: 2 });

  await assert.rejects(
    bridge.approveTool(c.approvalId, { action: 'approve_once', epoch: 1 }),
    (err: any) => {
      assert.ok(err.code === 4001 && err.name === 'StaleEpochError');
      return true;
    },
  );
  assert.strictEqual(await pending, false, 'a stale answer must never approve the tool');
});

test('grants epoch - missing epoch fails closed with 4001 and approves nothing', async () => {
  const bridge = makeBridge();
  const pending = bridge.requestUserApproval('exec_command', { command: 'git status' });
  const [c] = await pendingIds(bridge);

  await assert.rejects(
    bridge.approveTool(c.approvalId, { action: 'approve_once' }),
    (err: any) => {
      assert.ok(err.code === 4001 && err.name === 'StaleEpochError');
      return true;
    },
  );
  await assert.rejects(
    bridge.approveTool(c.approvalId, { action: 'always_allow' }),
    (err: any) => err.code === 4001,
  );
  assert.strictEqual((await bridge.grantsStore.read()).grants.length, 0, 'no grant stored without an epoch');
  assert.strictEqual((await bridge.listPendingApprovals()).length, 1, 'request stays pending so the client can retry');

  await bridge.approveTool(c.approvalId, { action: 'approve_once', epoch: c.epoch });
  assert.strictEqual(await pending, true);
});
