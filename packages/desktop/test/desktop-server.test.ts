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

  public destroy(): this {
    this.emit('close');
    return this;
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

    // Test POST /api/agents & GET /api/agents
    const reqCreateBot = new MockIncomingMessage('POST', '/api/agents');
    const resCreateBot = new MockServerResponse();
    const createBotPromise = (server as any).handleRequest(reqCreateBot, resCreateBot);
    reqCreateBot.emit('data', Buffer.from(JSON.stringify({
      name: 'Security Auditor',
      role: 'AppSec Engineer',
      systemPrompt: 'Audit code for security vulnerabilities',
    })));
    reqCreateBot.emit('end');
    await createBotPromise;
    assert.strictEqual(resCreateBot.statusCode, 201);
    const bot = JSON.parse(resCreateBot.body);
    assert.strictEqual(bot.name, 'Security Auditor');

    const reqListBots = new MockIncomingMessage('GET', '/api/agents');
    const resListBots = new MockServerResponse();
    await (server as any).handleRequest(reqListBots, resListBots);
    assert.strictEqual(resListBots.statusCode, 200);
    const bots = JSON.parse(resListBots.body);
    assert.strictEqual(bots.length, 1);
    assert.strictEqual(bots[0].name, 'Security Auditor');

    // Test POST /api/tasks & GET /api/tasks & PUT /api/tasks/:id
    const reqCreateTask = new MockIncomingMessage('POST', '/api/tasks');
    const resCreateTask = new MockServerResponse();
    const createTaskPromise = (server as any).handleRequest(reqCreateTask, resCreateTask);
    reqCreateTask.emit('data', Buffer.from(JSON.stringify({
      title: 'Fix bash injection vulnerability',
      priority: 'high',
    })));
    reqCreateTask.emit('end');
    await createTaskPromise;
    assert.strictEqual(resCreateTask.statusCode, 201);
    const task = JSON.parse(resCreateTask.body);
    assert.strictEqual(task.title, 'Fix bash injection vulnerability');

    const reqListTasks = new MockIncomingMessage('GET', '/api/tasks');
    const resListTasks = new MockServerResponse();
    await (server as any).handleRequest(reqListTasks, resListTasks);
    assert.strictEqual(resListTasks.statusCode, 200);
    const tasks = JSON.parse(resListTasks.body);
    assert.strictEqual(tasks.length, 1);

    // Test GET /api/learned-rules
    const reqRules = new MockIncomingMessage('GET', '/api/learned-rules');
    const resRules = new MockServerResponse();
    await (server as any).handleRequest(reqRules, resRules);
    assert.strictEqual(resRules.statusCode, 200);

    // Test Security: External Origin rejected with 403
    const reqUntrustedOrigin = new MockIncomingMessage('GET', '/api/settings', { origin: 'http://malicious-website.com' });
    const resUntrustedOrigin = new MockServerResponse();
    await (server as any).handleRequest(reqUntrustedOrigin, resUntrustedOrigin);
    assert.strictEqual(resUntrustedOrigin.statusCode, 403);

    // Test Security: Untrusted Host header rejected with 403 (DNS rebinding defense)
    const reqUntrustedHost = new MockIncomingMessage('GET', '/api/settings', { host: 'attacker-controlled.com' });
    const resUntrustedHost = new MockServerResponse();
    await (server as any).handleRequest(reqUntrustedHost, resUntrustedHost);
    assert.strictEqual(resUntrustedHost.statusCode, 403);

    // Test Security: Path traversal rejected on /api/sessions/:id
    const reqTraversal = new MockIncomingMessage('GET', '/api/sessions/..%2F..%2Fetc%2Fpasswd');
    const resTraversal = new MockServerResponse();
    await (server as any).handleRequest(reqTraversal, resTraversal);
    assert.strictEqual(resTraversal.statusCode, 400);

    // Test Security: Payload too large rejected with 413
    const reqOversized = new MockIncomingMessage('POST', '/api/settings');
    const resOversized = new MockServerResponse();
    const oversizedPromise = (server as any).handleRequest(reqOversized, resOversized);
    const hugeChunk = Buffer.alloc(2.5 * 1024 * 1024, 65); // 2.5MB
    reqOversized.emit('data', hugeChunk);
    await oversizedPromise;
    assert.strictEqual(resOversized.statusCode, 413);

    // Test Memory System Endpoints: POST /api/memories & GET /api/memories
    const reqAddMem = new MockIncomingMessage('POST', '/api/memories');
    const resAddMem = new MockServerResponse();
    const addMemPromise = (server as any).handleRequest(reqAddMem, resAddMem);
    reqAddMem.emit('data', Buffer.from(JSON.stringify({
      text: 'User prefers dark mode and zero telemetry',
      scope: 'user',
      tier: 'profile',
    })));
    reqAddMem.emit('end');
    await addMemPromise;
    assert.strictEqual(resAddMem.statusCode, 201);
    const addedMem = JSON.parse(resAddMem.body);
    assert.ok(addedMem.factId);
    assert.strictEqual(addedMem.tier, 'profile');

    const reqGetMem = new MockIncomingMessage('GET', '/api/memories?tier=profile');
    const resGetMem = new MockServerResponse();
    await (server as any).handleRequest(reqGetMem, resGetMem);
    assert.strictEqual(resGetMem.statusCode, 200);
    const memList = JSON.parse(resGetMem.body);
    assert.strictEqual(memList.length, 1);
    assert.strictEqual(memList[0].text, 'User prefers dark mode and zero telemetry');

    // Test Promote Memories to Team: POST /api/memories/promote
    const reqPromote = new MockIncomingMessage('POST', '/api/memories/promote');
    const resPromote = new MockServerResponse();
    const promotePromise = (server as any).handleRequest(reqPromote, resPromote);
    reqPromote.emit('data', Buffer.from(JSON.stringify({
      agentId: 'default',
      factIds: [addedMem.factId],
    })));
    reqPromote.emit('end');
    await promotePromise;
    assert.strictEqual(resPromote.statusCode, 200);
    const promoteResult = JSON.parse(resPromote.body);
    assert.strictEqual(promoteResult.created.length, 1);

    // Test GET /api/team-summary
    const reqSummary = new MockIncomingMessage('GET', '/api/team-summary');
    const resSummary = new MockServerResponse();
    await (server as any).handleRequest(reqSummary, resSummary);
    assert.strictEqual(resSummary.statusCode, 200);
    const teamSummary = JSON.parse(resSummary.body);
    assert.ok(teamSummary.memoryCount >= 1);

    // Test Team Review Queue: GET /api/team-review
    const reqTeamRev = new MockIncomingMessage('GET', '/api/team-review');
    const resTeamRev = new MockServerResponse();
    await (server as any).handleRequest(reqTeamRev, resTeamRev);
    assert.strictEqual(resTeamRev.statusCode, 200);
    const reviewItems = JSON.parse(resTeamRev.body);
    assert.ok(Array.isArray(reviewItems));

    // Test Attachments API: POST /api/attachments
    const sampleFilePath = path.join(tmpDir, 'test-doc.txt');
    fs.writeFileSync(sampleFilePath, 'OpenSand Desktop Attachment Content');
    const reqStageAtt = new MockIncomingMessage('POST', '/api/attachments');
    const resStageAtt = new MockServerResponse();
    const stagePromise = (server as any).handleRequest(reqStageAtt, resStageAtt);
    reqStageAtt.emit('data', Buffer.from(JSON.stringify({ filePath: sampleFilePath })));
    reqStageAtt.emit('end');
    await stagePromise;
    assert.strictEqual(resStageAtt.statusCode, 201);
    const stagedAtt = JSON.parse(resStageAtt.body);
    assert.ok(stagedAtt.id.startsWith('att_'));
    assert.strictEqual(stagedAtt.filename, 'test-doc.txt');

    // Test GET /api/attachments
    const reqListAtt = new MockIncomingMessage('GET', '/api/attachments');
    const resListAtt = new MockServerResponse();
    await (server as any).handleRequest(reqListAtt, resListAtt);
    assert.strictEqual(resListAtt.statusCode, 200);
    const attList = JSON.parse(resListAtt.body);
    assert.strictEqual(attList.length, 1);
    assert.strictEqual(attList[0].id, stagedAtt.id);

    // Test DELETE /api/attachments/:id
    const reqDelAtt = new MockIncomingMessage('DELETE', `/api/attachments/${stagedAtt.id}`);
    const resDelAtt = new MockServerResponse();
    await (server as any).handleRequest(reqDelAtt, resDelAtt);
    assert.strictEqual(resDelAtt.statusCode, 200);
    assert.strictEqual(JSON.parse(resDelAtt.body).success, true);

    // Test Templates API: GET /api/templates/:agentId
    const reqExportTpl = new MockIncomingMessage('GET', `/api/templates/${bot.id}`);
    const resExportTpl = new MockServerResponse();
    await (server as any).handleRequest(reqExportTpl, resExportTpl);
    assert.strictEqual(resExportTpl.statusCode, 200);
    const exportedTpl = JSON.parse(resExportTpl.body);
    assert.strictEqual(exportedTpl.templateVersion, '1.0.0');
    assert.strictEqual(exportedTpl.name, 'Security Auditor');

    // Test POST /api/templates/import
    const reqImportTpl = new MockIncomingMessage('POST', '/api/templates/import');
    const resImportTpl = new MockServerResponse();
    const importPromise = (server as any).handleRequest(reqImportTpl, resImportTpl);
    reqImportTpl.emit('data', Buffer.from(JSON.stringify({
      ...exportedTpl,
      name: 'Imported Auditor',
    })));
    reqImportTpl.emit('end');
    await importPromise;
    assert.strictEqual(resImportTpl.statusCode, 201);
    const importedAgent = JSON.parse(resImportTpl.body);
    assert.ok(importedAgent.id.startsWith('agent_imported_auditor_'));

    // Test POST /api/compact (error boundary when no active session)
    const reqCompact = new MockIncomingMessage('POST', '/api/compact');
    const resCompact = new MockServerResponse();
    const compactPromise = (server as any).handleRequest(reqCompact, resCompact);
    reqCompact.emit('data', Buffer.from(JSON.stringify({ keepRecentTurns: 2 })));
    reqCompact.emit('end');
    await compactPromise;
    assert.strictEqual(resCompact.statusCode, 400);
    assert.ok(JSON.parse(resCompact.body).error.includes('No active conversation coordinator'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
