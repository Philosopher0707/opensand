import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { DesktopServer } from '../src/desktop-server.js';
import { closeThenRemove } from './teardown.js';

class MockRequest extends EventEmitter {
  public socket = { remoteAddress: '127.0.0.1' };
  constructor(public method: string, public url: string, public headers: Record<string, string>) {
    super();
  }
  public destroy(): this { this.emit('close'); return this; }
}

class MockResponse extends EventEmitter {
  public statusCode = 200;
  public body = '';
  public setHeader(): void {}
  public writeHead(code: number): void { this.statusCode = code; }
  public write(chunk: string | Buffer): void { this.body += chunk.toString(); }
  public end(chunk?: string | Buffer): void { if (chunk) this.body += chunk.toString(); this.emit('finish'); }
}

async function postApprove(server: DesktopServer, body: unknown): Promise<MockResponse> {
  const req = new MockRequest('POST', '/api/approve', {
    host: '127.0.0.1:3456',
    authorization: `Bearer ${server.getAuthToken()}`,
  });
  const res = new MockResponse();
  const done = (server as any).handleRequest(req, res);
  req.emit('data', JSON.stringify(body));
  req.emit('end');
  await done;
  return res;
}

test('POST /api/approve - edited decision carries modifiedArgs and emits one resolved event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-approve-edit-route-'));
  const server = new DesktopServer({ baseDir: dir });
  const bridge = server.getBridge();
  const events: any[] = [];
  const onEvent = (e: any) => { if (e.type === 'approval_resolved') events.push(e.data); };
  bridge.on('event', onEvent);
  const unsub = () => bridge.off('event', onEvent);
  try {
    const outcome = bridge.requestApprovalOutcome('write_file', { path: 'original.txt', content: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    const [req] = await bridge.listPendingApprovals();

    const res = await postApprove(server, {
      approvalId: req.approvalId,
      decision: { action: 'approve_modified', epoch: req.epoch, modifiedArgs: { path: 'edited.txt', content: 'b' } },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { success: true });
    assert.deepStrictEqual(await outcome, { approved: true, modifiedArgs: { path: 'edited.txt', content: 'b' } });
    assert.deepStrictEqual(events, [{ approvalId: req.approvalId, action: 'approve_modified' }]);
  } finally {
    unsub();
    await closeThenRemove([bridge, server], dir);
  }
});

test('POST /api/approve - malformed edit gets 400 and no approval_resolved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-approve-edit-bad-'));
  const server = new DesktopServer({ baseDir: dir });
  const bridge = server.getBridge();
  const events: any[] = [];
  const onEvent = (e: any) => { if (e.type === 'approval_resolved') events.push(e.data); };
  bridge.on('event', onEvent);
  const unsub = () => bridge.off('event', onEvent);
  try {
    void bridge.requestApprovalOutcome('write_file', { path: 'original.txt' });
    await new Promise((r) => setTimeout(r, 10));
    const [req] = await bridge.listPendingApprovals();

    const res = await postApprove(server, {
      approvalId: req.approvalId,
      decision: { action: 'approve_modified', epoch: req.epoch, modifiedArgs: 'not-an-object' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(events, []);
    assert.strictEqual((await bridge.listPendingApprovals()).length, 1, 'a rejected edit leaves the answer pending');
  } finally {
    unsub();
    await closeThenRemove([bridge, server], dir);
  }
});
