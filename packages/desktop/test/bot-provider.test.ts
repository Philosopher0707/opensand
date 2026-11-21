import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';
import { AgentStore, providerRegistry, UniversalLLMClient } from '@opensand/coordinator';
import type { ProviderDriver } from '@opensand/shared';

test('per-bot provider persists and is used at turn time', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bot-provider-'));
  const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
  try {
    bridge.updateSettings({ autoApprove: true, provider: 'global-driver', model: 'global-model' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const store = new AgentStore(path.join(tmpDir, 'agents'));
    const bot = await store.createAgent({
      name: 'Provider Bot',
      role: 'Research Assistant',
      systemPrompt: 'research',
      model: 'bot-model',
      provider: 'bot-driver',
    });
    assert.strictEqual(bot.provider, 'bot-driver');

    const patched = await store.updateAgentSettings(bot.id, { model: 'patched-model' });
    assert.strictEqual(patched.provider, 'bot-driver', 'provider must survive an unrelated settings patch');
    assert.strictEqual(patched.model, 'patched-model');
    const reread = await store.getAgent(bot.id);
    assert.strictEqual(reread?.provider, 'bot-driver');

    // A registered driver's client must be chosen over the global provider.
    const marker = new UniversalLLMClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 'marker' });
    const models = { default: 'bot-model', options: [{ id: 'bot-model', label: 'Bot' }] };
    const fake: ProviderDriver = {
      driverKind: 'bot-driver',
      metadata: { displayName: 'Bot Driver', access: 'api' },
      models,
      decodeConfig: (raw) => raw,
      defaultConfig: () => ({}),
      async create(input) {
        return {
          instanceId: input.instanceId,
          driverKind: 'bot-driver',
          displayName: input.displayName,
          enabled: input.enabled,
          models,
          adapter: {
            provider: 'bot-driver',
            capabilities: {},
            async sendTurn() { return { text: '', toolCalls: [] }; },
            steer: () => Promise.resolve(),
            interruptTurn: () => Promise.resolve(),
            respondToRequest: () => Promise.resolve('unavailable' as const),
            hasSession: () => false,
            enginePid: () => undefined,
            stopAll: () => Promise.resolve(),
            onEvent: () => () => {},
          },
          createLlmClient: () => marker,
          snapshot: async () => ({ instanceId: input.instanceId, driverKind: 'bot-driver', enabled: input.enabled }),
          dispose: () => Promise.resolve(),
        };
      },
    };
    providerRegistry.register(fake);
    const coordinator = await bridge.createSessionCoordinator('provider-session', bot.id);
    assert.strictEqual((coordinator as any).llmClient, marker, 'bot provider must drive the coordinator client');
    await providerRegistry.disposeAll();
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('changing a bot provider invalidates the cached coordinator', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bot-provider-reload-'));
  const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
  try {
    bridge.updateSettings({ autoApprove: true, provider: 'global-driver', model: 'global-model' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const models = { default: 'bot-model', options: [{ id: 'bot-model', label: 'Bot' }] };
    const markerA = new UniversalLLMClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 'A' });
    const markerB = new UniversalLLMClient({ baseUrl: 'http://127.0.0.1:1/v1', model: 'B' });
    for (const [kind, marker] of [['driver-a', markerA], ['driver-b', markerB]] as const) {
      providerRegistry.register({
        driverKind: kind,
        metadata: { displayName: kind, access: 'api' },
        models,
        decodeConfig: (raw) => raw,
        defaultConfig: () => ({}),
        async create(input) {
          return {
            instanceId: input.instanceId, driverKind: kind, displayName: input.displayName,
            enabled: input.enabled, models,
            adapter: {
              provider: kind, capabilities: {},
              async sendTurn() { return { text: '', toolCalls: [] }; },
              steer: () => Promise.resolve(), interruptTurn: () => Promise.resolve(),
              respondToRequest: () => Promise.resolve('unavailable' as const),
              hasSession: () => false, enginePid: () => undefined,
              stopAll: () => Promise.resolve(), onEvent: () => () => {},
            },
            createLlmClient: () => marker,
            snapshot: async () => ({ instanceId: input.instanceId, driverKind: kind, enabled: input.enabled }),
            dispose: () => Promise.resolve(),
          };
        },
      });
    }
    const store = new AgentStore(path.join(tmpDir, 'agents'));
    const bot = await store.createAgent({
      name: 'Reload Bot', role: 'Assistant', systemPrompt: 'x',
      model: 'bot-model', provider: 'driver-a',
    });
    const before = await bridge.createSessionCoordinator('reload-session', bot.id);
    assert.strictEqual((before as any).llmClient, markerA);

    await bridge.updateAgentSettings(bot.id, { provider: 'driver-b' });
    const after = await bridge.createSessionCoordinator('reload-session', bot.id);
    assert.strictEqual((after as any).llmClient, markerB, 'a provider change must reach the next turn');
    await providerRegistry.disposeAll();
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});

test('a bot without a provider follows the global setting', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-bot-provider-global-'));
  const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
  try {
    bridge.updateSettings({ autoApprove: true, provider: 'openrouter', model: 'global-model' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const store = new AgentStore(path.join(tmpDir, 'agents'));
    const bot = await store.createAgent({
      name: 'Global Bot', role: 'Assistant', systemPrompt: 'x', model: 'bot-model',
    });
    assert.strictEqual(bot.provider, undefined);
    const coordinator = await bridge.createSessionCoordinator('global-session', bot.id);
    assert.ok(coordinator, 'bot with no provider override still gets a coordinator');
    assert.strictEqual((coordinator as any).llmClient.model, 'bot-model');
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
