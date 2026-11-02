import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DesktopServer } from '../src/desktop-server.js';

describe('Desktop Server - Policies, Webhooks, and AG-UI Endpoints', () => {
  let server: DesktopServer;
  let baseUrl: string;
  let tmpDir: string;
  const port = 3987;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-routes-test-'));
    server = new DesktopServer({
      port,
      host: '127.0.0.1',
      baseDir: tmpDir,
    });
    await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await server.stop();
  });

  function makeRequest(
    method: string,
    pathname: string,
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        `${baseUrl}${pathname}`,
        {
          method,
          headers: {
            'Host': '127.0.0.1',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let parsed = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // Raw string
            }
            resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
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
      conditions: {
        tools: ['exec_command'],
        commandsRegex: ['curl.*\\|.*(bash|sh|zsh)'],
      },
    };

    const postRes = await makeRequest('POST', '/api/policies', customRule);
    assert.strictEqual(postRes.status, 200);
    assert.strictEqual(postRes.body.success, true);

    const auditRes = await makeRequest('GET', '/api/policies/audit');
    assert.strictEqual(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.body));
  });

  it('manages webhooks via GET / POST / DELETE /api/webhooks and logs delivery', async () => {
    // 1. Register webhook
    const regRes = await makeRequest('POST', '/api/webhooks', {
      id: 'wh_test_ci',
      name: 'ci-webhook',
      targetType: 'graph',
      targetId: 'dummy_graph',
      enabled: true,
    });
    assert.strictEqual(regRes.status, 201);
    assert.strictEqual(regRes.body.name, 'ci-webhook');

    // 2. List webhooks
    const listRes = await makeRequest('GET', '/api/webhooks');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    assert.ok(listRes.body.some((w: any) => w.name === 'ci-webhook'));

    // 3. Get deliveries
    const delivRes = await makeRequest('GET', '/api/webhooks/deliveries');
    assert.strictEqual(delivRes.status, 200);
    assert.ok(Array.isArray(delivRes.body));

    // 4. Delete webhook
    const delRes = await makeRequest('DELETE', '/api/webhooks/ci-webhook');
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.success, true);
  });

  it('GET /api/graphs and POST /api/graphs/:id/run executes autonomous cyclical coding loop', async () => {
    // 1. List available graphs
    const listRes = await makeRequest('GET', '/api/graphs');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    assert.ok(listRes.body.length >= 2);
    const codingGraph = listRes.body.find((g: any) => g.id === 'self_reflecting_coding');
    assert.ok(codingGraph);
    assert.strictEqual(codingGraph.cycleLimit, 3);
    assert.deepStrictEqual(codingGraph.nodes, ['planner', 'coder', 'tester', 'reviewer']);

    // 2. Run graph execution
    const runRes = await makeRequest('POST', '/api/graphs/self_reflecting_coding/run', {
      task: 'Build authenticated webhook receiver with SHA-256 HMAC verification',
    });
    assert.strictEqual(runRes.status, 200);
    assert.strictEqual(runRes.body.completed, true);
    assert.ok(Array.isArray(runRes.body.trace));
    assert.ok(runRes.body.trace.length >= 4);

    // Verify events in trace
    const eventTypes = runRes.body.trace.map((e: any) => e.type);
    assert.ok(eventTypes.includes('node_start'));
    assert.ok(eventTypes.includes('node_end'));
    assert.ok(eventTypes.includes('edge_traversed'));
    assert.ok(eventTypes.includes('graph_complete'));

    // Check final summary
    assert.ok(runRes.body.finalState.finalSummary);
    assert.ok(runRes.body.finalState.finalSummary.includes('Architecture Review Complete'));
  });
});
