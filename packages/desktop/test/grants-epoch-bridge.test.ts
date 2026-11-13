import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge as BaseDesktopIpcBridge } from '../src/ipc-bridge.js';
import { DesktopServer } from '../src/desktop-server.js';
import { EventEmitter } from 'node:events';

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

test('grants epoch - POST /api/approve with a stale epoch returns HTTP 409 code 4001 and stores no grant', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-grants-http-'));
  tmpDirs.push(home);
  const server = new DesktopServer({ baseDir: path.join(home, '.opensand') });
  const bridge = (server as any).bridge as BaseDesktopIpcBridge;
  createdBridges.push(bridge);
  bridge.updateSettings({ autoApprove: false, model: 'test-grants-epoch' });
  const seed = await bridge.grantsStore.addGrant({ tool: 'exec_command', scope: 'ls *', lifetime: 'always' });
  const pending = bridge.requestUserApproval('exec_command', { command: 'npm test' });
  const [c] = await pendingIds(bridge);
  await bridge.revokeGrant(seed.id); // epoch 1 -> 2 while the approval is pending

  const req: any = new EventEmitter();
  Object.assign(req, {
    method: 'POST',
    url: '/api/approve',
    headers: { host: '127.0.0.1:3456', authorization: `Bearer ${server.getAuthToken()}` },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res: any = new EventEmitter();
  Object.assign(res, {
    statusCode: 200, headers: {} as Record<string, string>, body: '',
    setHeader(this: any, k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(this: any, code: number) { this.statusCode = code; },
    write(this: any, chunk: any) { this.body += chunk.toString(); },
    end(this: any, chunk?: any) { if (chunk) this.body += chunk.toString(); this.emit('finish'); },
  });
  const handled = (server as any).handleRequest(req, res);
  req.emit('data', JSON.stringify({ approvalId: c.approvalId, decision: { action: 'always_allow', epoch: 1 } }));
  req.emit('end');
  await handled;

  assert.strictEqual(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.code, 4001);
  assert.strictEqual(body.name, 'StaleEpochError');
  assert.strictEqual(await pending, false, 'the stale answer denies the request');
  assert.strictEqual((await bridge.grantsStore.read()).grants.length, 0, 'no grant stored at a stale epoch');
});
