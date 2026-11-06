import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { DesktopServer } from '../src/desktop-server.js';

// Hermetic mock for IncomingMessage
class MockIncomingMessage extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string>;
  public socket: any;
  public static defaultToken: string = '';

  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3456', ...headers };
    this.socket = { remoteAddress: '127.0.0.1' };
    if (!('authorization' in this.headers) && !('Authorization' in this.headers) && MockIncomingMessage.defaultToken) {
      this.headers['authorization'] = `Bearer ${MockIncomingMessage.defaultToken}`;
    }
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
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'openrouter-models.json'),
      JSON.stringify({
        timestamp: Date.now(),
        models: [
          { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek Flash', context_length: 1048576 },
        ],
      }),
      'utf8'
    );

    const server = new DesktopServer({ baseDir: tmpDir });
    MockIncomingMessage.defaultToken = server.getAuthToken();

    // Test Authentication Middleware: missing token returns 401
    const unauthReq = new MockIncomingMessage('GET', '/api/settings', { authorization: '' });
    const unauthRes = new MockServerResponse();
    await (server as any).handleRequest(unauthReq, unauthRes);
    assert.strictEqual(unauthRes.statusCode, 401);

    // Test Authentication Middleware: invalid token returns 401
    const badTokenReq = new MockIncomingMessage('GET', '/api/settings', { authorization: 'Bearer invalid-token-123' });
    const badTokenRes = new MockServerResponse();
    await (server as any).handleRequest(badTokenReq, badTokenRes);
    assert.strictEqual(badTokenRes.statusCode, 401);

    // Test Authentication Middleware: X-OpenSand-Token succeeds
    const customHeaderReq = new MockIncomingMessage('GET', '/api/settings', { authorization: '', 'x-opensand-token': server.getAuthToken() });
    const customHeaderRes = new MockServerResponse();
    await (server as any).handleRequest(customHeaderReq, customHeaderRes);
    assert.strictEqual(customHeaderRes.statusCode, 200);

    // Test Authentication Middleware: Cookie opensand_token succeeds
    const cookieReq = new MockIncomingMessage('GET', '/api/settings', { authorization: '', cookie: `opensand_token=${server.getAuthToken()}` });
    const cookieRes = new MockServerResponse();
    await (server as any).handleRequest(cookieReq, cookieRes);
    assert.strictEqual(cookieRes.statusCode, 200);

    // Test Authentication Middleware: Query ?token= rejected on standard API endpoints
    const queryReq = new MockIncomingMessage('GET', `/api/settings?token=${server.getAuthToken()}`, { authorization: '' });
    const queryRes = new MockServerResponse();
    await (server as any).handleRequest(queryReq, queryRes);
    assert.strictEqual(queryRes.statusCode, 401);

    // Test Authentication Middleware: Query ?token= permitted on SSE endpoint (/api/events)
    const sseQueryReq = new MockIncomingMessage('GET', `/api/events?token=${server.getAuthToken()}`, { authorization: '' });
    const sseQueryRes = new MockServerResponse();
    await (server as any).handleRequest(sseQueryReq, sseQueryRes);
    assert.strictEqual(sseQueryRes.statusCode, 200);

    // Test Token Exchange endpoint: POST /api/auth/token-exchange
    const tokenExchReq = new MockIncomingMessage('POST', '/api/auth/token-exchange', { authorization: '' });
    const tokenExchRes = new MockServerResponse();
    const tokenExchPromise = (server as any).handleRequest(tokenExchReq, tokenExchRes);
    tokenExchReq.emit('data', JSON.stringify({ token: server.getAuthToken() }));
    tokenExchReq.emit('end');
    await tokenExchPromise;
    assert.strictEqual(tokenExchRes.statusCode, 200);
    assert.ok(tokenExchRes.headers['set-cookie']?.includes('opensand_token='));

    // Test Token Exchange endpoint with invalid token returns 401
    const badExchReq = new MockIncomingMessage('POST', '/api/auth/token-exchange', { authorization: '' });
    const badExchRes = new MockServerResponse();
    const badExchPromise = (server as any).handleRequest(badExchReq, badExchRes);
    badExchReq.emit('data', JSON.stringify({ token: 'wrong-token' }));
    badExchReq.emit('end');
    await badExchPromise;
    assert.strictEqual(badExchRes.statusCode, 401);

    // Test token file idempotence: token file is NOT overwritten on startup if already valid
    const tokenFile = path.join(tmpDir, 'server.token');
    const originalToken = fs.readFileSync(tokenFile, 'utf8').trim();
    const mtimeBefore = fs.statSync(tokenFile).mtimeMs;
    const server2 = new DesktopServer({ baseDir: tmpDir });
    assert.strictEqual(server2.getAuthToken(), originalToken);
    const mtimeAfter = fs.statSync(tokenFile).mtimeMs;
    assert.strictEqual(mtimeAfter, mtimeBefore, 'server.token must not be rewritten if already valid');

    // Test webhook ingress per-IP rate limiting
    const whServer = new DesktopServer({ baseDir: tmpDir, webhookMaxRequestsPerMinute: 2 });
    const whReq1 = new MockIncomingMessage('POST', '/api/webhooks/test-hook', { authorization: '' });
    const whRes1 = new MockServerResponse();
    const p1 = (whServer as any).handleRequest(whReq1, whRes1);
    whReq1.emit('data', JSON.stringify({}));
    whReq1.emit('end');
    await p1;
    assert.notStrictEqual(whRes1.statusCode, 429);

    const whReq2 = new MockIncomingMessage('POST', '/api/webhooks/test-hook', { authorization: '' });
    const whRes2 = new MockServerResponse();
    const p2 = (whServer as any).handleRequest(whReq2, whRes2);
    whReq2.emit('data', JSON.stringify({}));
    whReq2.emit('end');
    await p2;
    assert.notStrictEqual(whRes2.statusCode, 429);

    const whReq3 = new MockIncomingMessage('POST', '/api/webhooks/test-hook', { authorization: '' });
    const whRes3 = new MockServerResponse();
    const p3 = (whServer as any).handleRequest(whReq3, whRes3);
    whReq3.emit('data', JSON.stringify({}));
    whReq3.emit('end');
    await p3;
    assert.strictEqual(whRes3.statusCode, 429);
    assert.ok(JSON.parse(whRes3.body).error.includes('rate limit'));

    // Test API 404 behavior: unmatched /api/* returns 404 JSON, never SPA index.html
    const notFoundReq = new MockIncomingMessage('GET', '/api/nonexistent-route-for-testing');
    const notFoundRes = new MockServerResponse();
    await (server as any).handleRequest(notFoundReq, notFoundRes);
    assert.strictEqual(notFoundRes.statusCode, 404);
    assert.ok(JSON.parse(notFoundRes.body).error.includes('Not found'));

    // Test GET /api/settings
    const req1 = new MockIncomingMessage('GET', '/api/settings');
    const res1 = new MockServerResponse();
    await (server as any).handleRequest(req1, res1);

    assert.strictEqual(res1.statusCode, 200);
    const settings = JSON.parse(res1.body);
    assert.strictEqual(settings.provider, 'openai');

    // Test API key redaction: key must be masked in API responses
    (server as any).bridge.updateSettings({ apiKey: 'sk-ant-api03-super-secret-key-12345' });
    const reqMasked = new MockIncomingMessage('GET', '/api/settings');
    const resMasked = new MockServerResponse();
    await (server as any).handleRequest(reqMasked, resMasked);
    const maskedData = JSON.parse(resMasked.body);
    assert.strictEqual(maskedData.apiKey, '********');

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

    // Test session management hygiene: Create, Load, Delete, and Clear
    const testSessionDir = path.join(tmpDir, 'sessions', 'test-sess-1');
    fs.mkdirSync(testSessionDir, { recursive: true });
    fs.writeFileSync(path.join(testSessionDir, 'transcript.jsonl'), JSON.stringify({ role: 'user', content: 'hello' }) + '\n');
    fs.writeFileSync(path.join(testSessionDir, 'transcript.txt'), 'hello transcript\n');

    const reqLoadSess = new MockIncomingMessage('GET', '/api/sessions/test-sess-1');
    const resLoadSess = new MockServerResponse();
    await (server as any).handleRequest(reqLoadSess, resLoadSess);
    assert.strictEqual(resLoadSess.statusCode, 200);
    const loadedSess = JSON.parse(resLoadSess.body);
    assert.strictEqual(loadedSess.events.length, 1);
    assert.strictEqual(loadedSess.transcript, 'hello transcript\n');

    // Test DELETE /api/sessions/:id
    const reqDelSess = new MockIncomingMessage('DELETE', '/api/sessions/test-sess-1');
    const resDelSess = new MockServerResponse();
    await (server as any).handleRequest(reqDelSess, resDelSess);
    assert.strictEqual(resDelSess.statusCode, 200);
    const delResult = JSON.parse(resDelSess.body);
    assert.strictEqual(delResult.success, true);
    assert.strictEqual(fs.existsSync(testSessionDir), false);

    // Test DELETE /api/sessions (clear all)
    const testSessionDir2 = path.join(tmpDir, 'sessions', 'test-sess-2');
    fs.mkdirSync(testSessionDir2, { recursive: true });
    const reqClearSess = new MockIncomingMessage('DELETE', '/api/sessions');
    const resClearSess = new MockServerResponse();
    await (server as any).handleRequest(reqClearSess, resClearSess);
    assert.strictEqual(resClearSess.statusCode, 200);
    const clearResult = JSON.parse(resClearSess.body);
    assert.strictEqual(clearResult.success, true);
    assert.strictEqual(clearResult.count, 1);
    assert.strictEqual(fs.existsSync(testSessionDir2), false);

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

    // Test Security: Missing Host header rejected with 400 Bad Request (fail closed)
    const reqMissingHost = new MockIncomingMessage('GET', '/api/settings');
    delete (reqMissingHost.headers as any).host;
    const resMissingHost = new MockServerResponse();
    await (server as any).handleRequest(reqMissingHost, resMissingHost);
    assert.strictEqual(resMissingHost.statusCode, 400);

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

    // Test DELETE /api/agents/:id
    const reqDeleteBot = new MockIncomingMessage('DELETE', `/api/agents/${importedAgent.id}`);
    const resDeleteBot = new MockServerResponse();
    await (server as any).handleRequest(reqDeleteBot, resDeleteBot);
    assert.strictEqual(resDeleteBot.statusCode, 200);
    const delBotResult = JSON.parse(resDeleteBot.body);
    assert.strictEqual(delBotResult.success, true);

    // Test POST /api/compact (error boundary when no active session)
    const reqCompact = new MockIncomingMessage('POST', '/api/compact');
    const resCompact = new MockServerResponse();
    const compactPromise = (server as any).handleRequest(reqCompact, resCompact);
    reqCompact.emit('data', Buffer.from(JSON.stringify({ keepRecentTurns: 2 })));
    reqCompact.emit('end');
    await compactPromise;
    assert.strictEqual(resCompact.statusCode, 400);
    assert.ok(JSON.parse(resCompact.body).error.includes('No active conversation coordinator'));

    // Test Token Telemetry API: GET /api/tokens (Model-aware dynamic context limit)
    const reqTokens = new MockIncomingMessage('GET', '/api/tokens');
    const resTokens = new MockServerResponse();
    await (server as any).handleRequest(reqTokens, resTokens);
    assert.strictEqual(resTokens.statusCode, 200);
    const tokenData = JSON.parse(resTokens.body);
    assert.strictEqual(typeof tokenData.estimatedTokens, 'number');
    assert.strictEqual(typeof tokenData.maxContextTokens, 'number');
    assert.strictEqual(tokenData.toolScopeMode, 'auto');

    // Dynamic model context window verification: Claude (200k)
    (server as any).bridge.updateSettings({ model: 'claude-3-5-sonnet-20241022' });
    const reqClaude = new MockIncomingMessage('GET', '/api/tokens');
    const resClaude = new MockServerResponse();
    await (server as any).handleRequest(reqClaude, resClaude);
    const claudeData = JSON.parse(resClaude.body);
    assert.strictEqual(claudeData.maxContextTokens, 200000);
    assert.strictEqual(claudeData.model, 'claude-3-5-sonnet-20241022');

    // Dynamic model context window verification: DeepSeek on OpenRouter (1,048,576 from OpenRouter listed models)
    (server as any).bridge.updateSettings({ model: 'deepseek/deepseek-v4.1-flash-1017', endpoint: 'https://openrouter.ai/api/v1' });
    const reqDeepseek = new MockIncomingMessage('GET', '/api/tokens');
    const resDeepseek = new MockServerResponse();
    await (server as any).handleRequest(reqDeepseek, resDeepseek);
    const deepseekData = JSON.parse(resDeepseek.body);
    assert.strictEqual(deepseekData.maxContextTokens, 1048576);
    assert.strictEqual(deepseekData.model, 'deepseek/deepseek-v4.1-flash-1017');

    // Test GET /api/models (Anthropic models)
    const reqAnthropicModels = new MockIncomingMessage('GET', '/api/models?provider=anthropic');
    const resAnthropicModels = new MockServerResponse();
    await (server as any).handleRequest(reqAnthropicModels, resAnthropicModels);
    assert.strictEqual(resAnthropicModels.statusCode, 200);
    const anthropicModelsData = JSON.parse(resAnthropicModels.body);
    assert.ok(Array.isArray(anthropicModelsData.models));
    assert.ok(anthropicModelsData.models.some((m: any) => m.id.includes('claude-3-7')));

    // Dynamic model context window verification: Qwen 8B (32,768)
    (server as any).bridge.updateSettings({ model: 'qwen3:8b' });
    const reqQwen = new MockIncomingMessage('GET', '/api/tokens');
    const resQwen = new MockServerResponse();
    await (server as any).handleRequest(reqQwen, resQwen);
    const qwenData = JSON.parse(resQwen.body);
    assert.strictEqual(qwenData.maxContextTokens, 32768);

    // Dynamic agent model override verification: Gemini (1,000,000)
    const testAgent = await (server as any).bridge.agentStore.createAgent({
      name: 'Gemini Researcher',
      role: 'Research',
      model: 'google/gemini-2.0-flash',
    });
    const reqAgentTokens = new MockIncomingMessage('GET', `/api/tokens?agentId=${testAgent.id}`);
    const resAgentTokens = new MockServerResponse();
    await (server as any).handleRequest(reqAgentTokens, resAgentTokens);
    const agentTokenData = JSON.parse(resAgentTokens.body);
    assert.strictEqual(agentTokenData.maxContextTokens, 1000000);
    assert.strictEqual(agentTokenData.model, 'google/gemini-2.0-flash');

    // Test Sentinel API: POST /api/sentinels
    const reqStartWatcher = new MockIncomingMessage('POST', '/api/sentinels');
    const resStartWatcher = new MockServerResponse();
    const startWatcherPromise = (server as any).handleRequest(reqStartWatcher, resStartWatcher);
    reqStartWatcher.emit('data', Buffer.from(JSON.stringify({
      targetDir: tmpDir,
      checkCommand: 'echo ok',
      autoHeal: true,
      debounceMs: 200,
    })));
    reqStartWatcher.emit('end');
    await startWatcherPromise;
    assert.strictEqual(resStartWatcher.statusCode, 201);
    const createdWatcher = JSON.parse(resStartWatcher.body);
    assert.ok(createdWatcher.id.startsWith('watcher_'));

    // Test Sentinel API: GET /api/sentinels
    const reqListWatchers = new MockIncomingMessage('GET', '/api/sentinels');
    const resListWatchers = new MockServerResponse();
    await (server as any).handleRequest(reqListWatchers, resListWatchers);
    assert.strictEqual(resListWatchers.statusCode, 200);
    const watcherList = JSON.parse(resListWatchers.body);
    assert.ok(Array.isArray(watcherList));
    assert.ok(watcherList.some((w: any) => w.id === createdWatcher.id));

    // Test Sentinel API: GET /api/sentinels/logs
    const reqSentinelLogs = new MockIncomingMessage('GET', '/api/sentinels/logs');
    const resSentinelLogs = new MockServerResponse();
    await (server as any).handleRequest(reqSentinelLogs, resSentinelLogs);
    assert.strictEqual(resSentinelLogs.statusCode, 200);
    const sentinelLogs = JSON.parse(resSentinelLogs.body);
    assert.ok(Array.isArray(sentinelLogs));

    // Test Sentinel API: DELETE /api/sentinels/:id
    const reqStopWatcher = new MockIncomingMessage('DELETE', `/api/sentinels/${createdWatcher.id}`);
    const resStopWatcher = new MockServerResponse();
    await (server as any).handleRequest(reqStopWatcher, resStopWatcher);
    assert.strictEqual(resStopWatcher.statusCode, 200);
    assert.strictEqual(JSON.parse(resStopWatcher.body).success, true);

    // Test Clean-Room Unified RPC Gateway: POST /aiserver.v1.AgentStoreService/ListAgents
    const reqRpcList = new MockIncomingMessage('POST', '/aiserver.v1.AgentStoreService/ListAgents');
    const resRpcList = new MockServerResponse();
    const rpcListPromise = (server as any).handleRequest(reqRpcList, resRpcList);
    reqRpcList.emit('end');
    await rpcListPromise;
    assert.strictEqual(resRpcList.statusCode, 200);
    const rpcListBody = JSON.parse(resRpcList.body);
    assert.ok(Array.isArray(rpcListBody.agents));

    // Test Clean-Room Unified RPC Gateway: POST /aiserver.v1.DashboardService/GetFleetStatus
    const reqRpcFleet = new MockIncomingMessage('POST', '/aiserver.v1.DashboardService/GetFleetStatus');
    const resRpcFleet = new MockServerResponse();
    const rpcFleetPromise = (server as any).handleRequest(reqRpcFleet, resRpcFleet);
    reqRpcFleet.emit('end');
    await rpcFleetPromise;
    assert.strictEqual(resRpcFleet.statusCode, 200);
    const rpcFleetBody = JSON.parse(resRpcFleet.body);
    assert.strictEqual(rpcFleetBody.fleet.status, 'operational');

    // Test Clean-Room Unified RPC Gateway: POST /aiserver.v1.AnalyticsService/TrackEvents
    const reqRpcAnalytics = new MockIncomingMessage('POST', '/aiserver.v1.AnalyticsService/TrackEvents');
    const resRpcAnalytics = new MockServerResponse();
    const rpcAnalyticsPromise = (server as any).handleRequest(reqRpcAnalytics, resRpcAnalytics);
    reqRpcAnalytics.emit('end');
    await rpcAnalyticsPromise;
    assert.strictEqual(resRpcAnalytics.statusCode, 200);
    assert.strictEqual(JSON.parse(resRpcAnalytics.body).recorded, true);

    // Test 3rd-Party OAuth Connectors API: GET /api/connectors
    const reqConnectors = new MockIncomingMessage('GET', '/api/connectors');
    const resConnectors = new MockServerResponse();
    await (server as any).handleRequest(reqConnectors, resConnectors);
    assert.strictEqual(resConnectors.statusCode, 200);
    const connectorsList = JSON.parse(resConnectors.body);
    assert.ok(Array.isArray(connectorsList));
    assert.strictEqual(connectorsList.length, 3);
    const connectorIds = connectorsList.map((c: any) => c.id);
    assert.ok(connectorIds.includes('slack'));
    assert.ok(connectorIds.includes('linear'));
    assert.ok(connectorIds.includes('github'));

    // Test Connector API: GET /api/connectors/slack
    const reqSlackConn = new MockIncomingMessage('GET', '/api/connectors/slack');
    const resSlackConn = new MockServerResponse();
    await (server as any).handleRequest(reqSlackConn, resSlackConn);
    assert.strictEqual(resSlackConn.statusCode, 200);
    const slackConn = JSON.parse(resSlackConn.body);
    assert.strictEqual(slackConn.id, 'slack');
    assert.strictEqual(slackConn.status, 'disconnected');

    // Test Connector API: POST /api/connectors/linear/connect (initiate OAuth)
    const reqLinearOAuth = new MockIncomingMessage('POST', '/api/connectors/linear/connect');
    const resLinearOAuth = new MockServerResponse();
    const linearOAuthPromise = (server as any).handleRequest(reqLinearOAuth, resLinearOAuth);
    reqLinearOAuth.emit('data', JSON.stringify({}));
    reqLinearOAuth.emit('end');
    await linearOAuthPromise;
    assert.strictEqual(resLinearOAuth.statusCode, 200);
    const linearFlow = JSON.parse(resLinearOAuth.body);
    assert.strictEqual(linearFlow.providerId, 'linear');
    assert.ok(linearFlow.authUrl.includes('linear.app/oauth/authorize'));
    assert.ok(linearFlow.state);

    // Test Connector API: POST /api/connectors/slack/connect (token configuration)
    const reqSlackToken = new MockIncomingMessage('POST', '/api/connectors/slack/connect');
    const resSlackToken = new MockServerResponse();
    const slackTokenPromise = (server as any).handleRequest(reqSlackToken, resSlackToken);
    reqSlackToken.emit('data', JSON.stringify({ token: 'xoxb-test-token', account: 'Acme Slack' }));
    reqSlackToken.emit('end');
    await slackTokenPromise;
    assert.strictEqual(resSlackToken.statusCode, 200);
    const slackConnected = JSON.parse(resSlackToken.body);
    assert.strictEqual(slackConnected.status, 'connected');
    assert.strictEqual(slackConnected.account, 'Acme Slack');

    // Test Connector API: POST /api/connectors/slack/test
    const reqSlackTest = new MockIncomingMessage('POST', '/api/connectors/slack/test');
    const resSlackTest = new MockServerResponse();
    const slackTestPromise = (server as any).handleRequest(reqSlackTest, resSlackTest);
    reqSlackTest.emit('data', JSON.stringify({}));
    reqSlackTest.emit('end');
    await slackTestPromise;
    assert.strictEqual(resSlackTest.statusCode, 200);
    const slackTestResult = JSON.parse(resSlackTest.body);
    assert.strictEqual(slackTestResult.ok, true);
    assert.strictEqual(slackTestResult.account, 'Acme Slack');

    // Test Connector API: POST /api/connectors/slack/disconnect
    const reqSlackDisc = new MockIncomingMessage('POST', '/api/connectors/slack/disconnect');
    const resSlackDisc = new MockServerResponse();
    const slackDiscPromise = (server as any).handleRequest(reqSlackDisc, resSlackDisc);
    reqSlackDisc.emit('data', JSON.stringify({}));
    reqSlackDisc.emit('end');
    await slackDiscPromise;
    assert.strictEqual(resSlackDisc.statusCode, 200);
    assert.strictEqual(JSON.parse(resSlackDisc.body).success, true);

    // Verify Slack is now disconnected
    const reqSlackAfter = new MockIncomingMessage('GET', '/api/connectors/slack');
    const resSlackAfter = new MockServerResponse();
    await (server as any).handleRequest(reqSlackAfter, resSlackAfter);
    assert.strictEqual(JSON.parse(resSlackAfter.body).status, 'disconnected');

    // Test Community Agent Store & Template Gallery API: GET /api/gallery/templates
    const reqGallery = new MockIncomingMessage('GET', '/api/gallery/templates');
    const resGallery = new MockServerResponse();
    await (server as any).handleRequest(reqGallery, resGallery);
    assert.strictEqual(resGallery.statusCode, 200);
    const galleryItems = JSON.parse(resGallery.body);
    assert.ok(Array.isArray(galleryItems));
    assert.strictEqual(galleryItems.length, 8);
    const hasReviewer = galleryItems.some((t: any) => t.id === 'code-reviewer');
    assert.strictEqual(hasReviewer, true);

    // Test Gallery API: GET /api/gallery/templates/code-reviewer
    const reqReviewer = new MockIncomingMessage('GET', '/api/gallery/templates/code-reviewer');
    const resReviewer = new MockServerResponse();
    await (server as any).handleRequest(reqReviewer, resReviewer);
    assert.strictEqual(resReviewer.statusCode, 200);
    const reviewerData = JSON.parse(resReviewer.body);
    assert.strictEqual(reviewerData.id, 'code-reviewer');
    assert.strictEqual(reviewerData.name, 'Code Reviewer & PR Auditor');

    // Test Gallery API: POST /api/gallery/templates/code-reviewer/install
    const reqInstall = new MockIncomingMessage('POST', '/api/gallery/templates/code-reviewer/install');
    const resInstall = new MockServerResponse();
    const installPromise = (server as any).handleRequest(reqInstall, resInstall);
    reqInstall.emit('data', JSON.stringify({}));
    reqInstall.emit('end');
    await installPromise;
    assert.strictEqual(resInstall.statusCode, 200);
    const installResult = JSON.parse(resInstall.body);
    assert.ok(installResult.agent);
    assert.strictEqual(installResult.agent.name, 'Code Reviewer & PR Auditor');

    // Test Gallery API: POST /api/gallery/templates/publish
    const reqPublish = new MockIncomingMessage('POST', '/api/gallery/templates/publish');
    const resPublish = new MockServerResponse();
    const publishPromise = (server as any).handleRequest(reqPublish, resPublish);
    reqPublish.emit('data', JSON.stringify({
      id: 'my-custom-bot',
      name: 'Custom Bot',
      role: 'Custom Bot Specialist',
      description: 'A custom community template.',
      systemPrompt: 'Assist with custom bot duties.',
      category: 'engineering',
      allowedTools: ['read_file'],
      author: 'Tester',
      version: '1.0.0',
      icon: '🤖',
      recommendedModel: 'anthropic/claude-sonnet',
      tags: ['custom', 'test'],
    }));
    reqPublish.emit('end');
    await publishPromise;
    assert.strictEqual(resPublish.statusCode, 201);
    const publishedItem = JSON.parse(resPublish.body);
    assert.strictEqual(publishedItem.id, 'my-custom-bot');
    assert.strictEqual(publishedItem.isCommunity, true);

    // Test Gallery API: DELETE /api/gallery/templates/my-custom-bot
    const reqDelCustom = new MockIncomingMessage('DELETE', '/api/gallery/templates/my-custom-bot');
    const resDelCustom = new MockServerResponse();
    await (server as any).handleRequest(reqDelCustom, resDelCustom);
    assert.strictEqual(resDelCustom.statusCode, 200);
    assert.strictEqual(JSON.parse(resDelCustom.body).success, true);

    // Test Gallery API: DELETE /api/gallery/templates/code-reviewer (Curated protected)
    const reqDelCurated = new MockIncomingMessage('DELETE', '/api/gallery/templates/code-reviewer');
    const resDelCurated = new MockServerResponse();
    await (server as any).handleRequest(reqDelCurated, resDelCurated);
    assert.strictEqual(resDelCurated.statusCode, 200);
    assert.strictEqual(JSON.parse(resDelCurated.body).success, false);

    // Test static renderer syntax validation
    const appJsPath = path.join(__dirname, '../../renderer/app.js');
    assert.doesNotThrow(() => {
      execSync(`node --check "${appJsPath}"`);
    }, 'renderer/app.js must be valid JavaScript syntax');

    const mdJsPath = path.join(__dirname, '../../renderer/modules/chat/markdown.js');
    assert.doesNotThrow(() => {
      execSync(`node --input-type=module -e 'import "${mdJsPath}"'`);
    }, 'markdown.js module must be valid ES module syntax');

    // Regression: renderMarkdown executes cleanly with fenced code blocks (no ReferenceError: rawCode)
    assert.doesNotThrow(() => {
      execSync(`node --input-type=module -e '
        import { renderMarkdown, renderMarkdownCached } from "${mdJsPath}";
        const output = renderMarkdown("Here is some code:\\n\`\`\`typescript\\nconst foo: number = 42;\\n\`\`\`\\nMore text.");
        if (!output.includes("tok-keyword") || !output.includes("language-typescript")) {
          throw new Error("Failed to render syntax-highlighted code block");
        }
        const cached = renderMarkdownCached("cached text with \`code\`");
        if (!cached.includes("<code>code</code>")) {
          throw new Error("Cached render failed");
        }
      '`);
    }, 'renderMarkdown must render fenced code blocks without runtime reference errors');

    const appQueueJsPath = path.join(__dirname, '../../renderer/modules/chat/approval-queue.js');
    assert.doesNotThrow(() => {
      execSync(`node --input-type=module -e 'import "${appQueueJsPath}"'`);
    }, 'approval-queue.js module must be valid ES module syntax');

    const canvasJsPath = path.join(__dirname, '../../renderer/modules/chat/canvas.js');
    assert.doesNotThrow(() => {
      execSync(`node --input-type=module -e 'import "${canvasJsPath}"'`);
    }, 'canvas.js module must be valid ES module syntax');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopServer - exposes read-only pending approvals and live tool discovery', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-server-parity-'));
  try {
    const server = new DesktopServer({ baseDir: tmpDir });
    MockIncomingMessage.defaultToken = server.getAuthToken();

    const approvalsReq = new MockIncomingMessage('GET', '/api/approvals');
    const approvalsRes = new MockServerResponse();
    await (server as any).handleRequest(approvalsReq, approvalsRes);
    assert.strictEqual(approvalsRes.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(approvalsRes.body), []);

    const toolsReq = new MockIncomingMessage('GET', '/api/tools');
    const toolsRes = new MockServerResponse();
    await (server as any).handleRequest(toolsReq, toolsRes);
    assert.strictEqual(toolsRes.statusCode, 200);
    const tools = JSON.parse(toolsRes.body);
    assert.strictEqual(tools.totalTools, tools.tools.length);
    assert.ok(tools.tools.some((tool: any) => tool.name === 'create_agent'));

    const unauthApprovalsReq = new MockIncomingMessage('GET', '/api/approvals', { authorization: '' });
    const unauthApprovalsRes = new MockServerResponse();
    await (server as any).handleRequest(unauthApprovalsReq, unauthApprovalsRes);
    assert.strictEqual(unauthApprovalsRes.statusCode, 401);

    const unauthToolsReq = new MockIncomingMessage('GET', '/api/tools', { authorization: '' });
    const unauthToolsRes = new MockServerResponse();
    await (server as any).handleRequest(unauthToolsReq, unauthToolsRes);
    assert.strictEqual(unauthToolsRes.statusCode, 401);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
