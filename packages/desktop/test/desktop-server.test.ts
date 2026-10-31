import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { DesktopServer } from '../src/desktop-server.js';

// Hermetic mock for IncomingMessage
class MockIncomingMessage extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string>;

  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
  }
}

// Hermetic mock for ServerResponse
class MockServerResponse extends EventEmitter {
  public statusCode: number = 200;
  public headers: Record<string, string> = {};
  public body: string = '';

  public setHeader(key: string, val: string) {
    this.headers[key.toLowerCase()] = val;
  }

  public writeHead(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    }
  }

  public write(chunk: string | Buffer) {
    this.body += chunk.toString();
  }

  public end(chunk?: string | Buffer) {
    if (chunk) {
      this.body += chunk.toString();
    }
    this.emit('finish');
  }
}

test('DesktopServer - handles REST API endpoints hermetically', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-server-test-'));

  try {
    const server = new DesktopServer({ baseDir: tmpDir });

    // Test GET /api/settings
    const req1 = new MockIncomingMessage('GET', '/api/settings');
    const res1 = new MockServerResponse();
    await (server as any).handleRequest(req1, res1);

    assert.strictEqual(res1.statusCode, 200);
    const settings = JSON.parse(res1.body);
    assert.strictEqual(settings.provider, 'openai');

    // Test POST /api/settings
    const req2 = new MockIncomingMessage('POST', '/api/settings');
    const res2 = new MockServerResponse();
    const handlePromise = (server as any).handleRequest(req2, res2);

    req2.emit('data', Buffer.from(JSON.stringify({ model: 'deepseek-coder' })));
    req2.emit('end');
    await handlePromise;

    assert.strictEqual(res2.statusCode, 200);
    const updated = JSON.parse(res2.body);
    assert.strictEqual(updated.model, 'deepseek-coder');

    // Test GET /api/sessions
    const req3 = new MockIncomingMessage('GET', '/api/sessions');
    const res3 = new MockServerResponse();
    await (server as any).handleRequest(req3, res3);
    assert.strictEqual(res3.statusCode, 200);
    const sessions = JSON.parse(res3.body);
    assert.ok(Array.isArray(sessions));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
