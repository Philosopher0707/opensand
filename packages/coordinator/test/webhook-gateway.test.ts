import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { WebhookGateway, safeTimingCompare } from '../src/webhook-gateway.js';
import { StateGraph, END } from '../src/agent-graph.js';

describe('WebhookGateway - Inbound Proactive Event Triggers', () => {
  let tmpDir: string;
  let gateway: WebhookGateway;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-webhook-test-'));
    gateway = new WebhookGateway({ storageDir: tmpDir });
  });

  it('registers webhooks, persists them to disk, and reloads them', () => {
    gateway.registerWebhook({
      id: 'wh_ci_fail',
      name: 'ci-failure-hook',
      targetType: 'graph',
      targetId: 'self_repair_graph',
      enabled: true,
    });

    const wh = gateway.getWebhook('ci-failure-hook');
    assert.ok(wh);
    assert.strictEqual(wh?.targetType, 'graph');
    assert.strictEqual(wh?.targetId, 'self_repair_graph');

    const reloaded = new WebhookGateway({ storageDir: tmpDir });
    const reloadedWh = reloaded.getWebhook('ci-failure-hook');
    assert.ok(reloadedWh);
    assert.strictEqual(reloadedWh?.id, 'wh_ci_fail');
  });

  it('dispatches webhook payload into an AgentGraph workflow', async () => {
    interface GraphState extends Record<string, unknown> {
      webhookPayload?: { repo: string; branch: string };
      processed?: boolean;
    }

    const graph = new StateGraph<GraphState>();
    graph.addNode('handler', (state) => ({
      processed: true,
    }));
    graph.setEntryPoint('handler');
    graph.addEdge('handler', END);

    const compiled = graph.compile();
    gateway.registerGraph('ci_graph', compiled);

    gateway.registerWebhook({
      id: 'wh_ci',
      name: 'ci-dispatch',
      targetType: 'graph',
      targetId: 'ci_graph',
      enabled: true,
    });

    const result = await gateway.handleWebhook('ci-dispatch', {
      repo: 'opensand',
      branch: 'main',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'dispatched');

    const logs = gateway.getDeliveryLogs(5);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].status, 'success');
  });

  it('verifies GitHub HMAC-SHA256 signatures securely', async () => {
    const secret = 'super-secret-ci-key-123';
    gateway.registerWebhook({
      id: 'wh_gh',
      name: 'github-pr',
      secret,
      targetType: 'graph',
      targetId: 'dummy_graph',
      filterEvent: 'pull_request',
      enabled: true,
    });

    // Mock dummy graph
    const dummyGraph = new StateGraph<any>();
    dummyGraph.addNode('noop', (s) => s);
    dummyGraph.setEntryPoint('noop');
    dummyGraph.addEdge('noop', END);
    gateway.registerGraph('dummy_graph', dummyGraph.compile());

    const payload = { action: 'opened', pull_request: { number: 42 } };
    const rawPayload = JSON.stringify(payload);
    const validHmac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

    // 1. Valid signature and matching event
    const successResult = await gateway.handleWebhook('github-pr', payload, {
      'x-hub-signature-256': validHmac,
      'x-github-event': 'pull_request',
    });
    assert.strictEqual(successResult.success, true);
    assert.strictEqual(successResult.status, 'dispatched');

    // 2. Invalid signature
    const rejectedResult = await gateway.handleWebhook('github-pr', payload, {
      'x-hub-signature-256': 'sha256=badbadbadbad',
      'x-github-event': 'pull_request',
    });
    assert.strictEqual(rejectedResult.success, false);
    assert.strictEqual(rejectedResult.status, 'rejected');

    // 3. Filtered out event (e.g. 'push' when filtered on 'pull_request')
    const filteredResult = await gateway.handleWebhook('github-pr', payload, {
      'x-hub-signature-256': validHmac,
      'x-github-event': 'push',
    });
    assert.strictEqual(filteredResult.success, true);
    assert.ok(filteredResult.reason?.includes('filtered out'));
  });

  it('evaluates safeTimingCompare across all edge cases (timing-attack defense)', () => {
    // 1. Identical strings
    assert.strictEqual(safeTimingCompare('my-secret-key-12345', 'my-secret-key-12345'), true);

    // 2. Different strings of same length
    assert.strictEqual(safeTimingCompare('my-secret-key-12345', 'my-secret-key-99999'), false);

    // 3. Different lengths
    assert.strictEqual(safeTimingCompare('short', 'much-longer-string-with-extra-bytes'), false);

    // 4. Empty strings (fail closed)
    assert.strictEqual(safeTimingCompare('', ''), false);
    assert.strictEqual(safeTimingCompare('secret', ''), false);
    assert.strictEqual(safeTimingCompare('', 'secret'), false);

    // 5. Non-string types (fail closed without throwing)
    assert.strictEqual(safeTimingCompare(null, 'secret'), false);
    assert.strictEqual(safeTimingCompare('secret', undefined), false);
    assert.strictEqual(safeTimingCompare(12345, '12345'), false);
    assert.strictEqual(safeTimingCompare({}, {}), false);
  });

  it('enforces timing-safe Bearer token and custom header authentication', async () => {
    const secret = 'bearer-auth-token-xyz-789';
    gateway.registerWebhook({
      id: 'wh_bearer',
      name: 'ci-bearer',
      secret,
      targetType: 'graph',
      targetId: 'dummy_graph',
      enabled: true,
    });

    const dummyGraph = new StateGraph<any>();
    dummyGraph.addNode('step', (s) => ({ done: true }));
    dummyGraph.setEntryPoint('step');
    dummyGraph.addEdge('step', END);
    gateway.registerGraph('dummy_graph', dummyGraph.compile());

    // 1. Valid Bearer token
    const validBearer = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      authorization: `Bearer ${secret}`,
    });
    assert.strictEqual(validBearer.success, true);
    assert.strictEqual(validBearer.status, 'dispatched');

    // 2. Wrong Bearer token
    const wrongBearer = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      authorization: 'Bearer wrong-token-value',
    });
    assert.strictEqual(wrongBearer.success, false);
    assert.strictEqual(wrongBearer.status, 'rejected');

    // 3. Empty Bearer token
    const emptyBearer = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      authorization: 'Bearer ',
    });
    assert.strictEqual(emptyBearer.success, false);
    assert.strictEqual(emptyBearer.status, 'rejected');

    // 4. Non-Bearer authorization format
    const basicAuth = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    assert.strictEqual(basicAuth.success, false);
    assert.strictEqual(basicAuth.status, 'rejected');

    // 5. Valid custom token header (x-opensand-secret)
    const validCustom = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      'x-opensand-secret': secret,
    });
    assert.strictEqual(validCustom.success, true);
    assert.strictEqual(validCustom.status, 'dispatched');

    // 6. Valid custom token header (x-webhook-token)
    const validWebhookToken = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      'x-webhook-token': secret,
    });
    assert.strictEqual(validWebhookToken.success, true);
    assert.strictEqual(validWebhookToken.status, 'dispatched');

    // 7. Wrong custom token header
    const wrongCustom = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {
      'x-opensand-secret': 'attacker-forged-key',
    });
    assert.strictEqual(wrongCustom.success, false);
    assert.strictEqual(wrongCustom.status, 'rejected');

    // 8. Missing all authentication when secret is configured
    const missingAuth = await gateway.handleWebhook('ci-bearer', { event: 'deploy' }, {});
    assert.strictEqual(missingAuth.success, false);
    assert.strictEqual(missingAuth.status, 'rejected');
  });
});
