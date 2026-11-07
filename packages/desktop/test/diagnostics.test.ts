import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopServer } from '../src/desktop-server.js';

test('diagnostics report is redacted and names the local setup', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-diag-'));
  const server = new DesktopServer({ baseDir, port: 0, host: '127.0.0.1', appVersion: '9.9.9' });
  const { port } = await server.start();
  const url = `http://127.0.0.1:${port}/api/diagnostics`;
  const headers = { authorization: `Bearer ${server.getAuthToken()}` };

  try {
    await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://api.example.com/v1/chat/completions',
        model: 'diag-model',
        apiKey: 'sk-must-never-appear',
      }),
    });

    const res = await fetch(url, { headers });
    assert.equal(res.status, 200);
    const report = await res.json();

    assert.equal(report.data.app, '9.9.9');
    assert.equal(report.data.model, 'diag-model');
    assert.equal(report.data.apiKey, 'stored');
    assert.match(report.text, /OpenSand diagnostics/);
    assert.ok(!report.text.includes('sk-must-never-appear'));
    assert.ok(!JSON.stringify(report).includes('sk-must-never-appear'));
  } finally {
    await server.stop();
  }
});
