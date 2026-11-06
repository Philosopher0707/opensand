import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { DesktopServer } from '../src/desktop-server.js';

class MockIncomingMessage extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string>;
  public socket: any;
  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3456', ...headers };
    this.socket = { remoteAddress: '127.0.0.1' };
  }
  public destroy(): this { this.emit('close'); return this as any; }
}
class MockServerResponse extends EventEmitter {
  public statusCode: number = 200;
  public headers: Record<string, string> = {};
  public body: string = '';
  public setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  public writeHead(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
  }
  public write(chunk: string | Buffer) { this.body += chunk.toString(); }
  public end(chunk?: string | Buffer) {
    if (chunk) this.body += chunk.toString();
    this.emit('finish');
  }
}

describe('Desktop Server - Policies, Webhooks, and AG-UI Endpoints', () => {
  let server: DesktopServer;
  let tmpDir: string;
  let token: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-routes-test-'));
    server = new DesktopServer({ port: 0, host: '127.0.0.1', baseDir: tmpDir });
    token = server.getAuthToken();
    await (server as any).bridge.connectorManager.ensureLoaded();
  });

  async function makeRequest(method: string, pathname: string, body?: any) {
    const req = new MockIncomingMessage(method, pathname, { authorization: `Bearer ${token}` });
    const res = new MockServerResponse();
    const promise = (server as any).handleRequest(req, res);
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
    await promise;
    let parsed: any = res.body;
    try { parsed = JSON.parse(res.body); } catch { /* raw */ }
    return { status: res.statusCode, body: parsed };
  }

  it('GET /api/policies returns default policy presets', async () => {
    const res = await makeRequest('GET', '/api/policies');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 2);
    const ruleIds = res.body.map((r: any) => r.id);
    assert.ok(ruleIds.includes('rule_deny_sensitive_paths'));
    assert.ok(ruleIds.includes('rule_deny_destructive_cmds'));
  });

  it('POST /api/policies adds a new policy rule and GET /api/policies/audit lists audit logs', async () => {
    const customRule = {
      id: 'rule_deny_curl_pipe',
      name: 'Deny curl pipe to shell',
      description: 'Blocks piping remote curl scripts into bash',
      enabled: true,
      action: 'DENY',
      conditions: { tools: ['exec_command'], commandsRegex: ['curl.*\\|.*(bash|sh|zsh)'] },
    };
    const postRes = await makeRequest('POST', '/api/policies', customRule);
    assert.strictEqual(postRes.status, 200);
    assert.strictEqual(postRes.body.success, true);
    const auditRes = await makeRequest('GET', '/api/policies/audit');
    assert.strictEqual(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.body));
  });

  it('manages webhooks via GET / POST / DELETE /api/webhooks and logs delivery', async () => {
    const regRes = await makeRequest('POST', '/api/webhooks', {
      id: 'wh_test_ci', name: 'ci-webhook', targetType: 'graph', targetId: 'dummy_graph', enabled: true,
    });
    assert.strictEqual(regRes.status, 201);
    assert.strictEqual(regRes.body.name, 'ci-webhook');
    const listRes = await makeRequest('GET', '/api/webhooks');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    assert.ok(listRes.body.some((w: any) => w.name === 'ci-webhook'));
    const delivRes = await makeRequest('GET', '/api/webhooks/deliveries');
    assert.strictEqual(delivRes.status, 200);
    assert.ok(Array.isArray(delivRes.body));
    const delRes = await makeRequest('DELETE', '/api/webhooks/ci-webhook');
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.success, true);
  });

  it('GET /api/graphs and POST /api/graphs/:id/run executes autonomous cyclical coding loop', async () => {
    const listRes = await makeRequest('GET', '/api/graphs');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    assert.ok(listRes.body.length >= 2);
    const codingGraph = listRes.body.find((g: any) => g.id === 'self_reflecting_coding');
    assert.ok(codingGraph);
    assert.strictEqual(codingGraph.cycleLimit, 3);
    assert.deepStrictEqual(codingGraph.nodes, ['planner', 'coder', 'tester', 'reviewer']);
    const runRes = await makeRequest('POST', '/api/graphs/self_reflecting_coding/run', {
      task: 'Build authenticated webhook receiver with SHA-256 HMAC verification',
    });
    assert.strictEqual(runRes.status, 200);
    assert.strictEqual(runRes.body.completed, true);
    assert.ok(Array.isArray(runRes.body.trace));
    assert.ok(runRes.body.trace.length >= 4);
    const eventTypes = runRes.body.trace.map((e: any) => e.type);
    assert.ok(eventTypes.includes('node_start'));
    assert.ok(eventTypes.includes('node_end'));
    assert.ok(eventTypes.includes('edge_traversed'));
    assert.ok(eventTypes.includes('graph_complete'));
    assert.ok(runRes.body.finalState.finalSummary);
    assert.ok(runRes.body.finalState.finalSummary.includes('Architecture Review Complete'));
  });
});
