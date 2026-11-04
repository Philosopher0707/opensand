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
