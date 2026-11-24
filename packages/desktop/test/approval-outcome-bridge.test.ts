import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge as BaseDesktopIpcBridge } from '../src/ipc-bridge.js';
import { closeThenRemove } from './teardown.js';

const createdBridges: BaseDesktopIpcBridge[] = [];
const tmpDirs: string[] = [];

function makeBridge() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-approval-outcome-'));
  tmpDirs.push(home);
  const bridge = new BaseDesktopIpcBridge({ baseDir: path.join(home, '.opensand') });
  bridge.updateSettings({ autoApprove: false, model: 'test-approval-outcome' });
  createdBridges.push(bridge);
  return bridge;
}

test.afterEach(async () => {
  await closeThenRemove(createdBridges.splice(0), ...tmpDirs.splice(0));
});

async function pendingIds(bridge: BaseDesktopIpcBridge) {
  await new Promise((r) => setTimeout(r, 10));
  return bridge.listPendingApprovals();
}

function collectResolved(bridge: BaseDesktopIpcBridge) {
  const events: Array<{ approvalId: string; action: string }> = [];
  const onEvent = (e: any) => {
    if (e.type === 'approval_resolved') events.push(e.data);
  };
  bridge.on('event', onEvent);
  return { events, unsub: () => bridge.off('event', onEvent) };
}

test('approval edit - approve_modified resolves edited args, emits one event, persists no grant', async () => {
  const bridge = makeBridge();
  const { events, unsub } = collectResolved(bridge);
  try {
    const outcome = bridge.requestApprovalOutcome('exec_command', { command: 'echo original' });
    const [req] = await pendingIds(bridge);
    assert.deepStrictEqual(
      await bridge.approveTool(req.approvalId, {
        action: 'approve_modified',
        epoch: req.epoch,
        modifiedArgs: { command: 'echo edited' },
      }),
      { success: true },
    );
    assert.deepStrictEqual(await outcome, { approved: true, modifiedArgs: { command: 'echo edited' } });
    assert.deepStrictEqual(events, [{ approvalId: req.approvalId, action: 'approve_modified' }]);
    assert.deepStrictEqual((await bridge.grantsStore.read()).grants, [], 'an edit is never remembered as always');
    assert.deepStrictEqual(await bridge.listPendingApprovals(), []);
  } finally {
    unsub();
  }
});

test('approval edit - a malformed edit is denied without running original args', async () => {
  const bridge = makeBridge();
  const { events, unsub } = collectResolved(bridge);
  try {
    const outcome = bridge.requestApprovalOutcome('exec_command', { command: 'echo original' });
    const [req] = await pendingIds(bridge);
    await bridge.approveTool(req.approvalId, { action: 'approve_modified', epoch: req.epoch, modifiedArgs: [] as any });
    assert.deepStrictEqual(await outcome, { approved: false });
    assert.deepStrictEqual(events, [{ approvalId: req.approvalId, action: 'reject' }]);
  } finally {
    unsub();
  }
});

test('approval edit - reject emits approval_resolved once; a second answer emits nothing', async () => {
  const bridge = makeBridge();
  const { events, unsub } = collectResolved(bridge);
  try {
    const outcome = bridge.requestApprovalOutcome('write_file', { path: 'x.txt', content: 'hello' });
    const [req] = await pendingIds(bridge);
    assert.deepStrictEqual(await bridge.approveTool(req.approvalId, { action: 'reject', epoch: req.epoch }), { success: true });
    assert.deepStrictEqual(await outcome, { approved: false });
    assert.deepStrictEqual(await bridge.approveTool(req.approvalId, { action: 'approve_once', epoch: req.epoch }), { success: false });
    assert.deepStrictEqual(events, [{ approvalId: req.approvalId, action: 'reject' }]);
  } finally {
    unsub();
  }
});

test('approval edit - a stale epoch is rejected with no approval_resolved for that request', async () => {
  const bridge = makeBridge();
  const { events, unsub } = collectResolved(bridge);
  try {
    const seed = bridge.requestUserApproval('exec_command', { command: 'git status' });
    const target = bridge.requestApprovalOutcome('exec_command', { command: 'npm test' });
    const [first, second] = await pendingIds(bridge);
    await bridge.approveTool(first.approvalId, { action: 'always_allow', epoch: first.epoch });
    assert.strictEqual(await seed, true);

    const [grant] = (await bridge.grantsStore.read()).grants;
    await bridge.revokeGrant(grant.id);

    await assert.rejects(
      bridge.approveTool(second.approvalId, {
        action: 'approve_modified', epoch: second.epoch, modifiedArgs: { command: 'echo edited' },
      }),
      (err: any) => err.code === 4001 && err.name === 'StaleEpochError',
    );
    assert.deepStrictEqual(await target, { approved: false });
    assert.deepStrictEqual(events.filter((e) => e.approvalId === second.approvalId), [],
      'a stale 409 is not a decided approval');
  } finally {
    unsub();
  }
});
