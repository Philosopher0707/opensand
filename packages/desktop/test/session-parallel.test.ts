import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { DesktopServer } from '../src/desktop-server.js';
import {
  MAX_PARALLEL_SESSIONS_PER_AGENT,
  MAX_QUEUED_SENDS_PER_AGENT,
  SessionAdmission,
  SessionRuntimeRegistry,
  type QueuedSend,
} from '../src/session-parallel.js';

function send(n: number): QueuedSend {
  return { key: `s${n}:default`, sessionId: `s${n}`, query: `q${n}` };
}

test('SessionAdmission - caps concurrent sessions per agent and drains in FIFO order', () => {
  const admission = new SessionAdmission();
  for (let i = 0; i < MAX_PARALLEL_SESSIONS_PER_AGENT; i++) {
    const result = admission.admit('default', send(i));
    assert.deepStrictEqual(result, { admitted: true, queued: false });
  }

  const overflow = admission.admit('default', send(99));
  assert.strictEqual(overflow.admitted, false);
  assert.strictEqual(overflow.queued, true);

  const next = admission.finish('default', 's0:default');
  assert.strictEqual(next?.sessionId, 's99');
  assert.strictEqual(admission.finish('default', 's1:default')?.sessionId, undefined);
});

test('SessionAdmission - re-submitting a running session does not take another slot', () => {
  const admission = new SessionAdmission();
  for (let i = 0; i < MAX_PARALLEL_SESSIONS_PER_AGENT; i++) admission.admit('default', send(i));

  assert.deepStrictEqual(admission.admit('default', send(0)), { admitted: true, queued: false });
  for (let i = 0; i < MAX_QUEUED_SENDS_PER_AGENT; i++) {
    assert.strictEqual(admission.admit('default', send(50 + i)).queued, true);
  }
  assert.strictEqual(admission.admit('default', send(500)).reason, 'queue-full');
  assert.strictEqual(admission.finish('default', 's0:default')?.sessionId, 's50');
});

test('SessionRuntimeRegistry - registers by (session, agent) and finds by session', () => {
  const registry = new SessionRuntimeRegistry();
  const coordinator = { sessionId: 's1' } as any;
  const runtime = registry.register('s1:default', 's1', undefined, coordinator);
  assert.strictEqual(registry.get('s1:default'), runtime);
  assert.strictEqual(registry.findBySession('s1'), runtime);
  assert.strictEqual(registry.findBySession('missing'), undefined);
  registry.remove('s1:default');
  assert.strictEqual(registry.get('s1:default'), undefined);
});

interface FakeCoordinator {
  sessionId: string;
  runTurn: (query: string, signal: AbortSignal) => Promise<string>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function fakeBridge(baseDir: string) {
  const bridge = new DesktopIpcBridge({ baseDir, defaultSettings: { autoApprove: true } });
  const events: Array<{ type: string; sessionId?: string; data?: unknown }> = [];
  bridge.on('event', (event: any) => events.push(event));

  const coordinators = new Map<string, FakeCoordinator>();
  (bridge as any).createSessionCoordinator = async (sessionId?: string): Promise<FakeCoordinator> => {
    const id = sessionId || 'default';
    const existing = coordinators.get(id);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const runTurn = (_query: string, signal: AbortSignal) => new Promise<string>((res, rej) => {
      resolve = () => res(`answer:${id}`);
      reject = rej;
      signal.addEventListener('abort', () => rej(new Error('aborted')));
    });
    const coordinator = { sessionId: id, runTurn, resolve: () => resolve(), reject: (e: Error) => reject(e) };
    coordinators.set(id, coordinator);
    return coordinator;
  };

  return { bridge, events, coordinators };
}

test('DesktopIpcBridge - two sessions run concurrently with independent aborts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-parallel-'));
  try {
    const { bridge, events, coordinators } = fakeBridge(tmpDir);

    const a = await bridge.sendQuery('qA', 'sess-A');
    const b = await bridge.sendQuery('qB', 'sess-B');
    assert.strictEqual(a.sessionId, 'sess-A');
    assert.strictEqual(b.sessionId, 'sess-B');

    const runtimes = (bridge as any).sessionRuntimes;
    const ra = runtimes.get('sess-A:default');
    const rb = runtimes.get('sess-B:default');
    assert.ok(ra && rb);
    assert.notStrictEqual(ra.abort, rb.abort, 'each session owns its abort controller');
    assert.strictEqual(ra.running, true);
    assert.strictEqual(rb.running, true);

    bridge.emitEvent('token', { token: 'a' }, undefined, 'sess-A');
    bridge.emitEvent('token', { token: 'b' }, undefined, 'sess-B');
    const tokenA = events.find((e) => e.type === 'token' && (e.data as any)?.token === 'a');
    const tokenB = events.find((e) => e.type === 'token' && (e.data as any)?.token === 'b');
    assert.strictEqual(tokenA?.sessionId, 'sess-A');
    assert.strictEqual(tokenB?.sessionId, 'sess-B');

    const signalA = ra.abort!.signal;
    const signalB = rb.abort!.signal;
    const cancelled = await bridge.cancelTurn('sess-A');
    assert.strictEqual(cancelled.cancelled, true);
    assert.strictEqual(signalA.aborted, true);
    assert.strictEqual(signalB.aborted, false, 'cancelling A must not cancel B');
    assert.ok(coordinators.has('sess-A') && coordinators.has('sess-B'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('DesktopServer - /api/events filters by session and replays after a sequence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-parallel-sse-'));
  const server = new DesktopServer({ baseDir: tmpDir, port: 0, host: '127.0.0.1' });
  const readSse = async (url: string): Promise<string> => {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${server.getAuthToken()}` },
      signal: controller.signal,
    });
    assert.strictEqual(response.status, 200);
    const reader = response.body!.getReader();
    let text = '';
    const timer = setTimeout(() => controller.abort(), 120);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
    } catch {
      // abort ends the stream read
    } finally {
      clearTimeout(timer);
    }
    return text;
  };

  try {
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;
    const bridge = server.getBridge();
    bridge.emitEvent('token', { token: 'A1' }, undefined, 'sess-A');
    bridge.emitEvent('token', { token: 'B1' }, undefined, 'sess-B');
    bridge.emitEvent('token', { token: 'A2' }, undefined, 'sess-A');

    const streamA = await readSse(`${base}/api/events?sessionId=sess-A&after=0`);
    assert.ok(streamA.includes('"token":"A1"'));
    assert.ok(streamA.includes('"token":"A2"'));
    assert.ok(!streamA.includes('"token":"B1"'), 'other sessions must not leak');

    const firstSeq = Number(/id: (\d+)/.exec(streamA)?.[1]);
    assert.ok(firstSeq > 0);
    const replay = await readSse(`${base}/api/events?sessionId=sess-A&after=${firstSeq}`);
    assert.ok(replay.includes('"token":"A2"'));
    assert.ok(!replay.includes('"token":"A1"'), 'replay must skip already-seen events');
  } finally {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('DesktopIpcBridge - overflow sends are queued and drained when a slot frees', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-parallel-queue-'));
  try {
    const { bridge, coordinators } = fakeBridge(tmpDir);
    for (let i = 0; i < MAX_PARALLEL_SESSIONS_PER_AGENT; i++) {
      await bridge.sendQuery(`q${i}`, `s${i}`);
    }
    const overflow = await bridge.sendQuery('overflow', 's-overflow');
    assert.strictEqual(overflow.queued, true);

    // Settle one turn; the settle hook releases its slot and drains the queue.
    coordinators.get('s0')!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const drained = (bridge as any).sessionRuntimes.get('s-overflow:default');
    assert.ok(drained, 'the queued send must be dispatched when a slot frees');
    assert.strictEqual(drained.running, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('DesktopIpcBridge - cancelling a queued session does not stop another session', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-parallel-queuecancel-'));
  try {
    const { bridge, coordinators } = fakeBridge(tmpDir);
    for (let i = 0; i < MAX_PARALLEL_SESSIONS_PER_AGENT; i++) {
      await bridge.sendQuery(`q${i}`, `s${i}`);
    }
    assert.strictEqual((await bridge.sendQuery('overflow', 's-overflow')).queued, true);

    const activeSignal = (bridge as any).sessionRuntimes.get('s0:default').abort.signal;
    const cancelled = await bridge.cancelTurn('s-overflow');
    assert.strictEqual(cancelled.cancelled, true);
    assert.strictEqual(activeSignal.aborted, false, 'cancelling a queued turn must not abort a running session');

    coordinators.get('s0')!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual((bridge as any).sessionRuntimes.get('s-overflow:default'), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
