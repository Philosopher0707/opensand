import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { RpcGateway, createDefaultRpcGateway, RpcError } from '../src/rpc-gateway.js';

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

  public get writableEnded(): boolean {
    return this.body.length > 0 || this.statusCode !== 200;
  }
}

test('RpcGateway - registers custom RPC handlers and dispatches calls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-rpc-test-'));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const gateway = new RpcGateway(bridge);

    gateway.register('aiserver.v1.CustomService', 'Ping', async (req) => {
      return { pong: true, echo: req.text };
    });

    assert.strictEqual(gateway.has('aiserver.v1.CustomService', 'Ping'), true);
    assert.strictEqual(gateway.has('aiserver.v1.CustomService', 'Pong'), false);

    const req = new MockIncomingMessage('POST', '/aiserver.v1.CustomService/Ping');
    const res = new MockServerResponse();
    const result = await gateway.dispatch('aiserver.v1.CustomService', 'Ping', { text: 'hello' }, req as any, res as any);
    assert.deepStrictEqual(result, { pong: true, echo: 'hello' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createDefaultRpcGateway - handles GrokBotService and SandBoxService wire calls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-rpc-test-'));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const gateway = createDefaultRpcGateway(bridge);

    // 1. SandBoxService: WriteFile & ReadFile
    const filePath = path.join(tmpDir, 'test-rpc.txt');
    const reqWrite = new MockIncomingMessage('POST', '/aiserver.v1.SandBoxService/WriteFile');
    const resWrite = new MockServerResponse();
    const handledWrite = await gateway.handleHttpRequest(reqWrite as any, resWrite as any, {
      path: filePath,
      content: 'Clean-room wire test',
    });
    assert.strictEqual(handledWrite, true);
    assert.strictEqual(resWrite.statusCode, 200);

    const reqRead = new MockIncomingMessage('POST', '/aiserver.v1.SandBoxService/ReadFile');
    const resRead = new MockServerResponse();
    const handledRead = await gateway.handleHttpRequest(reqRead as any, resRead as any, {
      path: filePath,
    });
    assert.strictEqual(handledRead, true);
    assert.strictEqual(resRead.statusCode, 200);
    const readBody = JSON.parse(resRead.body);
    assert.ok(readBody.content.includes('Clean-room wire test'));

    // 2. GrokBotService: EnsureSandBox & EnsureSandBoxWindow
    const reqEnsure = new MockIncomingMessage('POST', '/aiserver.v1.GrokBotService/EnsureSandBox');
    const resEnsure = new MockServerResponse();
    await gateway.handleHttpRequest(reqEnsure as any, resEnsure as any, {});
    assert.strictEqual(resEnsure.statusCode, 200);
    assert.strictEqual(JSON.parse(resEnsure.body).ready, true);

    // 3. AgentStoreService: CreateAgent & ListAgents
    const reqCreateAgent = new MockIncomingMessage('POST', '/aiserver.v1.AgentStoreService/CreateAgent');
    const resCreateAgent = new MockServerResponse();
    await gateway.handleHttpRequest(reqCreateAgent as any, resCreateAgent as any, {
      name: 'SecurityAuditor',
      role: 'PR & AppSec Auditor',
      model: 'qwen2.5-coder:32b',
    });
    assert.strictEqual(resCreateAgent.statusCode, 200);
    const createdAgent = JSON.parse(resCreateAgent.body).agent;
    assert.strictEqual(createdAgent.name, 'SecurityAuditor');

    const reqListAgents = new MockIncomingMessage('POST', '/aiserver.v1.AgentStoreService/ListAgents');
    const resListAgents = new MockServerResponse();
    await gateway.handleHttpRequest(reqListAgents as any, resListAgents as any, {});
    assert.strictEqual(resListAgents.statusCode, 200);
    const agentList = JSON.parse(resListAgents.body).agents;
    assert.ok(agentList.some((a: any) => a.name === 'SecurityAuditor'));

    // 4. DashboardService: GetFleetStatus
    const reqFleet = new MockIncomingMessage('POST', '/aiserver.v1.DashboardService/GetFleetStatus');
    const resFleet = new MockServerResponse();
    await gateway.handleHttpRequest(reqFleet as any, resFleet as any, {});
    assert.strictEqual(resFleet.statusCode, 200);
    const fleetData = JSON.parse(resFleet.body);
    assert.strictEqual(fleetData.fleet.status, 'operational');
    assert.ok(fleetData.fleet.agentsCount >= 1);

    // 5. AnalyticsService: Zero-Leakage Privacy Sink (Wildcard)
    const reqAnalytics = new MockIncomingMessage('POST', '/aiserver.v1.AnalyticsService/TrackEvents');
    const resAnalytics = new MockServerResponse();
    await gateway.handleHttpRequest(reqAnalytics as any, resAnalytics as any, {
      events: [{ event: 'turn_started' }],
    });
    assert.strictEqual(resAnalytics.statusCode, 200);
    assert.strictEqual(JSON.parse(resAnalytics.body).recorded, true);

    // 6. Error handling: Unimplemented method produces 404
    const reqUnknown = new MockIncomingMessage('POST', '/aiserver.v1.UnknownService/UnknownMethod');
    const resUnknown = new MockServerResponse();
    await gateway.handleHttpRequest(reqUnknown as any, resUnknown as any, {});
    assert.strictEqual(resUnknown.statusCode, 404);
    assert.strictEqual(JSON.parse(resUnknown.body).code, 'not_found');

    // 7. Error handling: Invalid argument produces 400
    const reqBadExec = new MockIncomingMessage('POST', '/aiserver.v1.SandBoxService/ExecCommand');
    const resBadExec = new MockServerResponse();
    await gateway.handleHttpRequest(reqBadExec as any, resBadExec as any, {});
    assert.strictEqual(resBadExec.statusCode, 400);
    assert.strictEqual(JSON.parse(resBadExec.body).code, 'invalid_argument');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
