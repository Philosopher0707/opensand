import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { StateManager } from '@opensand/local-exec-daemon';

test('DesktopIpcBridge - manages settings and persistent config', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-test-'));

  try {
    const bridge = new DesktopIpcBridge({
      baseDir: tmpDir,
      defaultSettings: { model: 'test-model', autoApprove: false },
    });

    const initial = bridge.getSettings();
    assert.strictEqual(initial.model, 'test-model');
    assert.strictEqual(initial.autoApprove, false);

    // Update settings
    const updated = bridge.updateSettings({ model: 'gpt-4o', autoApprove: true });
    assert.strictEqual(updated.model, 'gpt-4o');
    assert.strictEqual(updated.autoApprove, true);

    // Verify written to config.json
    const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.model, 'gpt-4o');
    assert.strictEqual(parsed.autoApprove, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - handles approval resolutions and standing allowlist', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-appr-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    let eventEmitted = false;
    bridge.on('event', (evt) => {
      if (evt.type === 'approval_required') {
        eventEmitted = true;
      }
    });

    // Directly simulate approval tool dispatch
    const resPromise = bridge.requestUserApproval('exec_command', { command: 'git status' });
    assert.strictEqual(eventEmitted, true);

    const activeMap = (bridge as any).activeApprovals as Map<string, any>;
    const [approvalId] = Array.from(activeMap.keys());
    assert.ok(approvalId);

    // Test always_allow adds to standing allowlist
    const approveRes = await bridge.approveTool(approvalId, { action: 'always_allow' });
    assert.strictEqual(approveRes.success, true);

    const resolvedVal = await resPromise;
    assert.strictEqual(resolvedVal, true);

    // Check allowlist file
    const stateManager = new StateManager(path.join(tmpDir, 'state'));
    const gates = await stateManager.readPermissionGates();
    assert.ok(gates.standingAllowlist.includes('git'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - handles rejection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-reject-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    const resPromise = bridge.requestUserApproval('exec_command', { command: 'rm -f test' });
    const activeMap = (bridge as any).activeApprovals as Map<string, any>;
    const [approvalId] = Array.from(activeMap.keys());

    const approveRes = await bridge.approveTool(approvalId, { action: 'reject' });
    assert.strictEqual(approveRes.success, true);

    const resolvedVal = await resPromise;
    assert.strictEqual(resolvedVal, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - lists and loads session transcripts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-sess-'));

  try {
    const sessDir = path.join(tmpDir, 'sessions', 'test-session-1');
    fs.mkdirSync(sessDir, { recursive: true });

    const jsonl = [
      JSON.stringify({ role: 'user', content: 'What is 2+2?' }),
      JSON.stringify({ role: 'assistant', content: '4' }),
    ].join('\n');
    fs.writeFileSync(path.join(sessDir, 'transcript.jsonl'), jsonl, 'utf8');
    fs.writeFileSync(path.join(sessDir, 'transcript.txt'), '<user_query>\nWhat is 2+2?\n</user_query>\nassistant:\n4\n', 'utf8');

    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const sessions = await bridge.getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].id, 'test-session-1');
    assert.strictEqual(sessions[0].messageCount, 2);

    const loaded = await bridge.loadSession('test-session-1');
    assert.strictEqual(loaded.events.length, 2);
    assert.ok(loaded.transcript.includes('<user_query>'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - loads sessions and infers agentId for legacy sub_agent sessions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-subsess-'));
  try {
    const sid = 'sub_agent_agent_cto_bot_bc125a5f_1793839209094';
    const sessDir = path.join(tmpDir, 'sessions', sid);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'transcript.jsonl'), JSON.stringify({ role: 'user', content: 'plan this' }) + '\n', 'utf8');

    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    const sessions = await bridge.getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].agentId, 'agent_cto_bot_bc125a5f');

    const loaded = await bridge.loadSession(sid);
    assert.strictEqual(loaded.events.length, 1);
    assert.strictEqual(loaded.agentId, 'agent_cto_bot_bc125a5f');
    assert.strictEqual((bridge as any).activeAgentId, 'agent_cto_bot_bc125a5f');

    await assert.rejects(() => bridge.loadSession('../agents'), /Invalid sessionId/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - preserves active coordinator and emits session_started on query', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-persist-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    let startedSessionId: string | null = null;
    bridge.on('event', (evt) => {
      if (evt.type === 'session_started') {
        startedSessionId = (evt.data as any)?.sessionId;
      }
    });

    const coord1 = await bridge.createSessionCoordinator();
    const sessId1 = coord1.sessionId;
    assert.ok(sessId1);

    // Calling createSessionCoordinator with same sessionId should reuse coordinator
    const coord2 = await bridge.createSessionCoordinator(sessId1);
    assert.strictEqual(coord1, coord2);

    // sendQuery should emit session_started event with sessionId
    const res = await bridge.sendQuery('Hello', sessId1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sessionId, sessId1);
    assert.strictEqual(startedSessionId, sessId1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - cancelTurn aborts the active turn and is safe when idle', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-cancel-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    // Idle: reports no cancellation, does not throw
    const idle = await bridge.cancelTurn();
    assert.strictEqual(idle.success, true);
    assert.strictEqual(idle.cancelled, false);

    // Active: stub a coordinator whose runTurn honors the AbortSignal
    const fakeCoordinator: any = {
      sessionId: 'sess-cancel-test',
      runTurn: async (_q: string, signal?: AbortSignal) => {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException('Turn was cancelled by user', 'AbortError'));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(() => resolve('never'), 10000);
        });
        return 'never';
      },
    };
    (bridge as any).coordinator = fakeCoordinator;
    (bridge as any).currentSessionId = 'sess-cancel-test';
    (bridge as any).activeAbortController = null;
    // sendQuery creates the controller internally; emulate that here.
    const controller = new AbortController();
    (bridge as any).activeAbortController = controller;
    let aborted = false;
    fakeCoordinator.runTurn('x', controller.signal).catch((err: any) => {
      aborted = err?.name === 'AbortError';
    });
    const active = await bridge.cancelTurn();
    assert.strictEqual(active.success, true);
    assert.strictEqual(active.cancelled, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(aborted, true);

    // Controller cleared: a second cancel is a no-op again
    const idle2 = await bridge.cancelTurn();
    assert.strictEqual(idle2.cancelled, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - getTokenTelemetry calculates accurate context windows and handles agent model inheritance', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-telemetry-'));

  try {
    const bridge = new DesktopIpcBridge({
      baseDir: tmpDir,
      defaultSettings: {
        model: 'stealth/crouton-alpha',
        endpoint: 'https://openrouter.ai/api/v1',
      },
    });

    // Populate OpenRouter cache with crouton-alpha = 1,048,576
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'openrouter-models.json'),
      JSON.stringify({
        timestamp: Date.now(),
        models: [
          { id: 'stealth/crouton-alpha', name: 'Crouton Alpha', context_length: 1048576 },
          { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek Flash', context_length: 1048576 },
        ],
      }),
      'utf8'
    );

    // Initial telemetry for default model
    const t1 = await bridge.getTokenTelemetry();
    assert.strictEqual(t1.model, 'stealth/crouton-alpha');
    assert.strictEqual(t1.maxContextTokens, 1048576);

    // Create an agent with model: "default"
    const agentStore = (bridge as any).agentStore;
    const a1 = await agentStore.createAgent({
      name: 'Default Agent',
      model: 'default',
      systemPrompt: 'You are a test agent',
    });

    // Agent with model "default" should inherit stealth/crouton-alpha (1M tokens)
    const tAgent = await bridge.getTokenTelemetry(a1.id);
    assert.strictEqual(tAgent.model, 'stealth/crouton-alpha');
    assert.strictEqual(tAgent.maxContextTokens, 1048576);

    // Create an agent with a specific model: qwen3:8b (32,768 tokens)
    const a2 = await agentStore.createAgent({
      name: 'Qwen Agent',
      model: 'qwen3:8b',
      systemPrompt: 'You are qwen',
    });
    const tQwen = await bridge.getTokenTelemetry(a2.id);
    assert.strictEqual(tQwen.model, 'qwen3:8b');
    assert.strictEqual(tQwen.maxContextTokens, 32768);

    // Update settings to claude-3-7-sonnet
    bridge.updateSettings({ model: 'claude-3-7-sonnet-20250219' });
    const tClaude = await bridge.getTokenTelemetry();
    assert.strictEqual(tClaude.model, 'claude-3-7-sonnet-20250219');
    assert.strictEqual(tClaude.maxContextTokens, 200000);

    // Check disk session telemetry with messages.json
    const sessDir = path.join(tmpDir, 'sessions', 'test-session-json');
    fs.mkdirSync(sessDir, { recursive: true });
    const sampleMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Write a quick function.' },
      { role: 'assistant', content: 'function hello() { return "world"; }' },
    ];
    fs.writeFileSync(path.join(sessDir, 'messages.json'), JSON.stringify(sampleMessages), 'utf8');

    const tSession = await bridge.getTokenTelemetry(undefined, 'test-session-json');
    assert.strictEqual(tSession.messagesCount, 3);
    assert.strictEqual(tSession.turnsCount, 1);
    assert.ok(tSession.estimatedTokens > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('DesktopIpcBridge - config.json never stores the raw apiKey and is written 0o600 atomically', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-key-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    bridge.updateSettings({ model: 'test-model-x', apiKey: 'sk-secret-12345' });

    await new Promise((r) => setTimeout(r, 50));

    const configPath = path.join(tmpDir, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(!('apiKey' in parsed), 'apiKey must not be persisted to config.json');
    assert.ok(!raw.includes('sk-secret-12345'), 'raw key must not appear anywhere in config.json');
    assert.strictEqual(parsed.model, 'test-model-x');

    const mode = fs.statSync(configPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'config.json must be owner-only (0600)');

    // In-memory settings still carry the key for LLM calls
    assert.strictEqual(bridge.getSettings().apiKey, 'sk-secret-12345');

    // And the key must have been vaulted (never written in plaintext)
    const vault = (bridge as any).vaultStore;
    // updateSettings() vaults the key fire-and-forget, and a putSecret takes ~50ms
    // on this machine — the same as the fixed sleep above, so this raced and
    // flaked roughly one run in five. Poll for the write instead of guessing.
    let secret = await vault.getSecret('default-api-key');
    for (let i = 0; i < 100 && !secret; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      secret = await vault.getSecret('default-api-key');
    }
    assert.ok(secret, 'default-api-key must be vaulted');
    assert.strictEqual(secret.value, 'sk-secret-12345');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - legacy plaintext apiKey in config.json is migrated to the vault on load', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-legacy-'));

  try {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1', apiKey: 'sk-legacy-key', autoApprove: false, provider: 'openai', theme: 'dark' }, null, 2),
      'utf8'
    );

    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });

    // Legacy key migrated to vault. The migration is asynchronous, so poll for it
    // rather than sleeping a fixed 100ms (same flake as the settings test above).
    const vault = (bridge as any).vaultStore;
    let secret = await vault.getSecret('default-api-key');
    for (let i = 0; i < 100 && !secret; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      secret = await vault.getSecret('default-api-key');
    }
    assert.ok(secret, 'legacy key must be migrated to vault');
    assert.strictEqual(secret.value, 'sk-legacy-key');

    // In-memory key is the legacy value (kept for this session's LLM calls)
    assert.strictEqual(bridge.getSettings().apiKey, 'sk-legacy-key');

    // Next save must have stripped it
    bridge.updateSettings({ model: 'llama3.1' });
    const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
    assert.ok(!('apiKey' in JSON.parse(raw)), 'apiKey stripped on save');
    assert.ok(!raw.includes('sk-legacy-key'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('DesktopIpcBridge - approveTool accepts {action} decisions (string form normalized by renderer)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-approval-'));

  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    bridge.updateSettings({ autoApprove: false, model: 'test-approval-model' });

    // Simulate coordinator path: request creates a pending approval with reason
    const pending = (bridge as any).requestUserApproval('exec_command', { command: 'ls -la /tmp' }, 'Policy: destructive command requires approval');
    await new Promise((r) => setTimeout(r, 10));

    const activeApprovals: Map<string, { request: any; resolve: (v: boolean) => void }> = (bridge as any).activeApprovals;
    assert.strictEqual(activeApprovals.size, 1);
    const [approvalId, entry] = [...activeApprovals.entries()][0];
    assert.strictEqual(entry.request.reason, 'Policy: destructive command requires approval');

    // {action} form — the contract the renderer now sends
    const result = await bridge.approveTool(approvalId, { action: 'approve_once' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(await pending, true);
    assert.strictEqual(activeApprovals.size, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - approval reason is optional and tolerated when absent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-approval-noreason-'));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    bridge.updateSettings({ autoApprove: false, model: 'test-approval-noreason' });
    const pending = (bridge as any).requestUserApproval('read_file', { path: '/tmp/x.txt' });
    await new Promise((r) => setTimeout(r, 10));
    const activeApprovals: Map<string, { request: any; resolve: (v: boolean) => void }> = (bridge as any).activeApprovals;
    const [approvalId] = [...activeApprovals.entries()][0];
    assert.strictEqual(([...activeApprovals.values()][0].request as any).reason, undefined);
    const result = await bridge.approveTool(approvalId, { action: 'reject' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(await pending, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('DesktopIpcBridge - coordinator map is keyed by (sessionId, agentId)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-coordmap-'));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    bridge.updateSettings({ autoApprove: true, model: 'test-coordmap-model' });
    await new Promise((r) => setTimeout(r, 10));

    const c1 = await bridge.createSessionCoordinator('sess-A', undefined);
    const c2 = await bridge.createSessionCoordinator('sess-A', undefined);
    assert.strictEqual(c1, c2, 'same (session, default) must reuse the coordinator');

    const c3 = await bridge.createSessionCoordinator('sess-B', undefined);
    assert.notStrictEqual(c1, c3, 'different session must get a different coordinator');

    const c4 = await bridge.createSessionCoordinator('sess-A', 'agent-1');
    assert.notStrictEqual(c1, c4, 'different agent on same session must differ');

    assert.strictEqual(bridge.getCoordinatorFor('sess-A', undefined), c1);
    assert.strictEqual(bridge.getCoordinatorFor('sess-B', undefined), c3);
    assert.strictEqual(bridge.getCoordinatorFor('sess-A', 'agent-1'), c4);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DesktopIpcBridge - autoApprove safety ceiling enforces prompt on dangerous commands & policy gates', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bridge-safety-ceiling-'));
  try {
    const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
    bridge.updateSettings({ autoApprove: true, model: 'test-model' });

    // 1. Safe command is auto-approved without prompting
    const safeRes = await bridge.requestUserApproval('exec_command', { command: 'git status' });
    assert.strictEqual(safeRes, true);

    // 2. Dangerous command (rm -rf /) MUST NOT auto-approve even with autoApprove: true
    let promptedDangerous = false;
    bridge.on('event', (evt) => {
      if (evt.type === 'approval_required' && evt.data?.toolName === 'exec_command') {
        promptedDangerous = true;
      }
    });

    const dangerousPromise = bridge.requestUserApproval('exec_command', { command: 'rm -rf /' });
    // Let event cycle
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(promptedDangerous, true, 'Dangerous command must prompt user despite autoApprove');

    const activeApprovals = (bridge as any).activeApprovals as Map<string, any>;
    const [approvalId] = Array.from(activeApprovals.keys());
    assert.ok(approvalId);

    // Reject it
    await bridge.approveTool(approvalId, { action: 'reject' });
    const dangerousRes = await dangerousPromise;
    assert.strictEqual(dangerousRes, false);

    // 3. Custom policy rule requiring approval MUST NOT auto-approve
    bridge.daemon.policy.setRule({
      id: 'rule_require_appr_write',
      name: 'Require Approval for Critical Config Write',
      enabled: true,
      action: 'REQUIRE_APPROVAL',
      conditions: {
        tools: ['write_file'],
        pathsPrefix: ['config.production.json'],
      },
    });

    let promptedPolicy = false;
    bridge.on('event', (evt) => {
      if (evt.type === 'approval_required' && evt.data?.toolName === 'write_file') {
        promptedPolicy = true;
      }
    });

    const policyPromise = bridge.requestUserApproval('write_file', { path: 'config.production.json', content: '{}' });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(promptedPolicy, true, 'Policy REQUIRE_APPROVAL must prompt user despite autoApprove');

    const [policyApprovalId] = Array.from(activeApprovals.keys());
    await bridge.approveTool(policyApprovalId, { action: 'approve_once' });
    const policyRes = await policyPromise;
    assert.strictEqual(policyRes, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
