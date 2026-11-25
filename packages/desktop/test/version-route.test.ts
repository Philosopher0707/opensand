import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopServer } from '../src/desktop-server.js';

test('GET /api/version returns only the app and electron versions', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-version-'));
  const server = new DesktopServer({ baseDir, port: 0, host: '127.0.0.1', appVersion: '9.9.9' });
  const { port } = await server.start();
  const headers = { authorization: `Bearer ${server.getAuthToken()}` };

  try {
    await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://api.example.com/v1', model: 'secret-model', apiKey: 'sk-must-never-appear' }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.app, '9.9.9');
    assert.ok('electron' in body);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('sk-must-never-appear'));
    assert.ok(!raw.includes('secret-model'));
    assert.ok(!raw.includes('api.example.com'));
    assert.ok(!raw.includes('apiKey'));
    assert.ok(!raw.includes('stateDir'));
  } finally {
    await server.stop();
  }
});
