import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { VaultStore } from '../src/vault-store.js';

test('VaultStore - securely stores, decrypts and lists secrets', async () => {
  const tmpDir = path.join(os.tmpdir(), `opensand-vault-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    const vault = new VaultStore({ baseDir: tmpDir });

    // 1. Put Secret
    const sec1 = await vault.putSecret({
      name: 'OPENAI_API_KEY',
      value: 'sk-proj-secret-key-1234567890abcdef',
      description: 'Production OpenAI Key',
    });
    assert.strictEqual(sec1.name, 'OPENAI_API_KEY');
    assert.strictEqual(sec1.value, 'sk-proj-secret-key-1234567890abcdef');
    assert.ok(sec1.id);

    // 2. Put Second Secret
    await vault.putSecret({
      name: 'NVIDIA_API_KEY',
      value: 'nvapi-9876543210zyxwvutsrq',
      description: 'Nvidia NIM key',
    });

    // 3. List Secrets (verify values are NOT returned, only previews)
    const list = await vault.listSecrets();
    assert.strictEqual(list.length, 2);
    assert.strictEqual((list[0] as any).value, undefined);
    assert.strictEqual(list[0].hasValue, true);
    assert.ok(list[0].preview.includes('...'));

    // 4. Get Secret by name
    const fetched = await vault.getSecret('OPENAI_API_KEY');
    assert.ok(fetched);
    assert.strictEqual(fetched?.value, 'sk-proj-secret-key-1234567890abcdef');

    // 5. Delete Secret
    const deleted = await vault.deleteSecret('OPENAI_API_KEY');
    assert.strictEqual(deleted, true);

    const listAfterDelete = await vault.listSecrets();
    assert.strictEqual(listAfterDelete.length, 1);
    assert.strictEqual(listAfterDelete[0].name, 'NVIDIA_API_KEY');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('VaultStore - securely manages credentials and accounts', async () => {
  const tmpDir = path.join(os.tmpdir(), `opensand-cred-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    const vault = new VaultStore({ baseDir: tmpDir });

    const cred = await vault.putCredential({
      title: 'GitHub Enterprise',
      username: 'octocat',
      password: 'ghp_super_secret_token_abc123',
      sites: ['github.com', 'api.github.com'],
      kind: 'TOKEN',
    });
    assert.strictEqual(cred.title, 'GitHub Enterprise');
    assert.strictEqual(cred.kind, 'TOKEN');

    const list = await vault.listCredentials();
    assert.strictEqual(list.length, 1);
    assert.strictEqual((list[0] as any).password, undefined);
    assert.strictEqual(list[0].hasPassword, true);

    const fetched = await vault.getCredential(cred.id);
    assert.ok(fetched);
    assert.strictEqual(fetched?.password, 'ghp_super_secret_token_abc123');

    const deleted = await vault.deleteCredential(cred.id);
    assert.strictEqual(deleted, true);
    const listEmpty = await vault.listCredentials();
    assert.strictEqual(listEmpty.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('VaultStore - automatically redacts known secrets from text', async () => {
  const tmpDir = path.join(os.tmpdir(), `opensand-redact-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    const vault = new VaultStore({ baseDir: tmpDir });

    await vault.putSecret({
      name: 'DEEPSEEK_API_KEY',
      value: 'sk-25f2beece7118239018302198301',
    });
    await vault.putCredential({
      title: 'Prod Database',
      username: 'postgres',
      password: 'SuperSecretDatabasePassword123!',
      kind: 'PASSWORD',
    });

    const dirtyText = `Command failed with error: sk-25f2beece7118239018302198301 was rejected while connecting with SuperSecretDatabasePassword123!`;
    const cleanText = vault.redactText(dirtyText);

    assert.ok(!cleanText.includes('sk-25f2beece7118239018302198301'));
    assert.ok(!cleanText.includes('SuperSecretDatabasePassword123!'));
    assert.ok(cleanText.includes('[REDACTED_VAULT_SECRET:DEEPSEEK_API_KEY]'));
    assert.ok(cleanText.includes('[REDACTED_VAULT_SECRET:Prod Database]'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
