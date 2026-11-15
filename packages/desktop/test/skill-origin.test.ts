import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

// A skill created from the desktop UI is the person's own. The renderer cannot pick
// the origin, so it cannot claim "user" for something else or "agent" for its own.
test('createSkill via the bridge stamps origin "user" and ignores the input origin', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-skill-origin-'));
  const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
  try {
    const record = await bridge.createSkill({
      name: 'Origin probe',
      description: 'probe',
      content: 'Do the thing.',
      origin: 'agent',
    });
    assert.strictEqual(record.origin, 'user');

    const stored = (await bridge.listSkills()).find((s) => s.id === record.id);
    assert.strictEqual(stored?.origin, 'user');

    const agent = await bridge.createAgent({ name: 'probe-agent', role: 'tester', systemPrompt: 'test' });
    const mounted = await bridge.skillStore.mountSkillToAgent(agent.id, record.id);
    assert.ok(mounted.mountedSkills.includes(record.id));
    const prompt = await bridge.skillStore.formatSkillsPrompt(agent.id);
    assert.match(prompt, /installed by you/);
    assert.doesNotMatch(prompt, /written by the AI/);
    assert.doesNotMatch(prompt, /origin not recorded/);
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
