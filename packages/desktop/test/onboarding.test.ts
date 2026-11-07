import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopServer } from '../src/desktop-server.js';
import { getOnboardingState } from '../src/onboarding.js';
import type { DesktopSettings } from '@opensand/shared';

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-onboarding-'));
}

function source(settings: Pick<DesktopSettings, 'endpoint' | 'model' | 'apiKey'>) {
  return { getSanitizedSettingsResolved: async () => settings as DesktopSettings };
}

test('needs onboarding when there is no key and no local model server', async () => {
  const probe = async () => ({ available: false, models: [] });

  const state = await getOnboardingState(
    source({ endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1', apiKey: 'none' }),
    probe,
  );

  assert.equal(state.needsOnboarding, true);
  assert.equal(state.hasApiKey, false);
});

test('a running local model needs no onboarding', async () => {
  const probe = async () => ({ available: true, models: ['qwen2.5-coder:7b'] });

  const state = await getOnboardingState(
    source({ endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1', apiKey: 'none' }),
    probe,
  );

  assert.equal(state.needsOnboarding, false);
  assert.deepEqual(state.ollama.models, ['qwen2.5-coder:7b']);
});

test('a stored key means no onboarding, without probing', async () => {
  let probed = false;
  const probe = async () => {
    probed = true;
    return { available: false, models: [] };
  };

  const state = await getOnboardingState(
    source({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', apiKey: '********' }),
    probe,
  );

  assert.equal(state.needsOnboarding, false);
  assert.equal(state.hasApiKey, true);
  assert.equal(probed, false);
});

test('a deliberately configured local endpoint is not onboarding', async () => {
  let probed = false;
  const probe = async () => {
    probed = true;
    return { available: false, models: [] };
  };

  const state = await getOnboardingState(
    source({ endpoint: 'http://localhost:1234/v1/chat/completions', model: 'local-model', apiKey: 'none' }),
    probe,
  );

  assert.equal(state.needsOnboarding, false);
  assert.equal(probed, false);
});

test('the onboarding endpoint stores a key through the server', async () => {
  const server = new DesktopServer({ baseDir: tempBase(), port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${server.getAuthToken()}` };

  try {
    // Remote endpoint with no key: onboarding is required (no Ollama probe involved).
    const settingsRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        apiKey: 'none',
      }),
    });
    assert.equal(settingsRes.status, 200);

    const stateRes = await fetch(`${base}/api/onboarding`, { headers: auth });
    assert.equal(stateRes.status, 200);
    const state = await stateRes.json();
    assert.equal(state.needsOnboarding, true);

    const bad = await fetch(`${base}/api/onboarding`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'key', endpoint: 'not-a-url', model: '', apiKey: '' }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/api/onboarding`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'key',
        endpoint: 'https://api.example.com/v1/chat/completions',
        model: 'test-model',
        apiKey: 'sk-test-123',
      }),
    });
    assert.equal(ok.status, 200);

    const after = await (await fetch(`${base}/api/onboarding`, { headers: auth })).json();
    assert.equal(after.needsOnboarding, false);
    assert.equal(after.hasApiKey, true);
    assert.equal(after.model, 'test-model');
    assert.equal(after.endpoint, 'https://api.example.com/v1/chat/completions');
  } finally {
    await server.stop();
  }
});
