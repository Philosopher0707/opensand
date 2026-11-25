import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DesktopServer } from '../src/desktop-server.js';
import { closeThenRemove } from './teardown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDist = __dirname.includes(`${path.sep}dist${path.sep}`);
const fakeBinDir = path.resolve(
  __dirname,
  isDist ? '../../../coordinator/test/fixtures/engines/fakes' : '../../coordinator/test/fixtures/engines/fakes'
);
const originalPath = process.env.PATH || '';

class MockRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket = { remoteAddress: '127.0.0.1' };
  constructor(method: string, url: string) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3456' };
  }
  destroy(): this { this.emit('close'); return this; }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  body = '';
  headers: Record<string, string> = {};
  setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; }
  writeHead(code: number) { this.statusCode = code; }
  write(chunk: string) { this.body += chunk.toString(); }
  end(chunk?: string) { if (chunk) this.body += chunk.toString(); this.emit('finish'); }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a turn event');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('desktop server streams a Claude Code turn, resumes it, and leaves the default path unchanged', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-engine-select-'));
  const server = new DesktopServer({ baseDir: tmp, requireAuth: false });
  const bridge = server.getBridge();
  // The fake engines are on PATH; `claude` is found passively (no credential reads).
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
  const fakeLog = path.join(tmp, 'fake-claude.json');
  process.env.FAKE_LOG = fakeLog;
  const tokens: string[] = [];
  const errors: any[] = [];
  let completed: any;
  let cancelled = false;
  bridge.on('event', (e: any) => {
    if (e.type === 'token') tokens.push(e.data?.token || '');
    if (e.type === 'error') errors.push(e.data);
    if (e.type === 'turn_complete') completed = e.data;
    if (e.type === 'turn_cancelled') cancelled = true;
  });

  async function postQuery(query: string, sessionId: string): Promise<any> {
    const req = new MockRequest('POST', '/api/query');
    const res = new MockResponse();
    const pending = (server as any).handleRequest(req, res);
    req.emit('data', Buffer.from(JSON.stringify({ query, sessionId })));
    req.emit('end');
    await pending;
    return JSON.parse(res.body || '{}');
  }

  try {
    await bridge.folderTrustStore.setLevel(process.cwd(), 'trusted');
    bridge.updateSettings({ engine: 'claude' });

    // Happy path: the fake reply is streamed as token events by the desktop server.
    const accepted = await postQuery('hello from claude', 'engine-select-session');
    assert.equal(accepted.success, true);
    await waitFor(() => Boolean(completed && /hello from claude/.test(completed.response)));
    assert.match(completed.response, /hello from claude/);
    assert.match(tokens.join(''), /hello from claude/);
    assert.equal(errors.length, 0);
    assert.equal((bridge.getCoordinator() as any)?.engineConfig?.engine, 'claude');

    // Resume: the second turn in the same session passes the stored engine session id.
    completed = undefined;
    await postQuery('second turn', 'engine-select-session');
    await waitFor(() => Boolean(completed && /continued sess-claude-1/.test(completed.response)));
    assert.match(completed.response, /continued sess-claude-1/);
    const log = JSON.parse(fs.readFileSync(fakeLog, 'utf8'));
    assert.ok(log.args.includes('--resume'), 'fake claude must receive --resume on the second turn');
    assert.ok(log.args.includes('sess-claude-1'), 'fake claude must receive the stored resume id');

    // Not signed in: plain, user-facing message, no raw stderr.
    completed = undefined;
    errors.length = 0;
    await postQuery('FAIL_AUTH', 'engine-select-auth');
    await waitFor(() => errors.length > 0);
    assert.match(errors[0].message, /not signed in/i);
    assert.match(errors[0].message, /claude login/i);
    assert.doesNotMatch(errors[0].message, /Error: not logged in/);
    // Signed-out engine: the saved engine falls back to OpenSand.
    assert.equal(bridge.getSettings().engine, 'opensand');
    assert.match(errors[0].message, /OpenSand/);

    // Cancel mid-turn: the turn ends gracefully through the desktop server.
    errors.length = 0;
    await postQuery('HANG', 'engine-select-cancel');
    await waitFor(() => {
      const logRaw = fs.existsSync(fakeLog) ? JSON.parse(fs.readFileSync(fakeLog, 'utf8')) : {};
      return Boolean(logRaw.pid);
    });
    await bridge.cancelTurn();
    await waitFor(() => cancelled);

    // Default path unchanged: with no engine selected, no external engine config is built.
    bridge.updateSettings({ engine: 'opensand' });
    const defaultCoordinator = await bridge.createSessionCoordinator('engine-select-default');
    assert.equal((defaultCoordinator as any).engineConfig, undefined);
  } finally {
    delete process.env.FAKE_LOG;
    process.env.PATH = originalPath;
    await closeThenRemove([server, bridge], tmp);
  }
});

test('passive engine detection route reports the fake claude binary', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-engine-detect-'));
  const server = new DesktopServer({ baseDir: tmp, requireAuth: false });
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
  try {
    const req = new MockRequest('GET', '/api/engines/detect');
    const res = new MockResponse();
    const pending = (server as any).handleRequest(req, res);
    req.emit('end');
    await pending;
    assert.equal(res.statusCode, 200);
    const engines = JSON.parse(res.body);
    const claude = engines.find((e: any) => e.engine === 'claude');
    assert.equal(claude.installed, true);
    // Exact keys: no binaryPath, version or auth message may leave the process.
    for (const e of engines) assert.deepEqual(Object.keys(e).sort(), ['engine', 'installed', 'signedIn']);
    assert.doesNotMatch(res.body, /binaryPath|version|authMessage|\/fake/i);
  } finally {
    process.env.PATH = originalPath;
    await closeThenRemove([server, server.getBridge()], tmp);
  }
});

test('OpenCode ACP provider-auth failure falls back to OpenSand', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-engine-opencode-auth-'));
  const server = new DesktopServer({ baseDir: tmp, requireAuth: false });
  const bridge = server.getBridge();
  // Recorded production shape: session/prompt answers with a JSON-RPC provider-auth error,
  // not a stderr line and exit. The wrapper renders "has no working sign-in", not "is not signed in".
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
  const errors: any[] = [];
  bridge.on('event', (e: any) => { if (e.type === 'error') errors.push(e.data); });

  async function postQuery(query: string, sessionId: string): Promise<any> {
    const req = new MockRequest('POST', '/api/query');
    const res = new MockResponse();
    const pending = (server as any).handleRequest(req, res);
    req.emit('data', Buffer.from(JSON.stringify({ query, sessionId })));
    req.emit('end');
    await pending;
    return JSON.parse(res.body || '{}');
  }

  try {
    await bridge.folderTrustStore.setLevel(process.cwd(), 'trusted');
    bridge.updateSettings({ engine: 'opencode' });
    const accepted = await postQuery('PROVIDER_AUTH', 'engine-select-opencode-auth');
    assert.equal(accepted.success, true);
    await waitFor(() => errors.length > 0);

    assert.match(errors[0].message, /OpenCode has no working sign-in/i, "plain provider-auth explanation survives");
    assert.match(errors[0].message, /fake\/model-a/, "the provider's model is kept in the message");
    assert.doesNotMatch(errors[0].message, /jsonrpc|-32000|Error:/i, "no raw ACP framing reaches the user");
    assert.match(errors[0].message, /Switched back to OpenSand/i, "the fallback is announced");
    assert.equal(bridge.getSettings().engine, 'opensand', "the saved engine is reset");
    assert.equal((bridge as any).coordinatorMap.size, 0, "cached session coordinators are cleared");
  } finally {
    process.env.PATH = originalPath;
    await closeThenRemove([server, bridge], tmp);
  }
});
