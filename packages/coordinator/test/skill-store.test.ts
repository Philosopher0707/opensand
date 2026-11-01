import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SkillStore } from '../src/skill-store.js';
import { AgentStore } from '../src/agent-store.js';

test('SkillStore - creates, lists, mounts, and formats skills for agents', async () => {
  const tmpDir = path.join(os.tmpdir(), `opensand-skill-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const agentDir = path.join(tmpDir, 'agents');
  const skillDir = path.join(tmpDir, 'skills');

  try {
    const agentStore = new AgentStore(agentDir);
    const skillStore = new SkillStore({ baseDir: skillDir, agentStore });

    // 1. Create Skills
    const skill1 = await skillStore.createSkill({
      name: 'postgresql-tuning',
      description: 'Guidelines for indexing, EXPLAIN ANALYZE, and query optimization.',
      content: 'Always check execution plans with EXPLAIN (ANALYZE, BUFFERS). Add B-tree indexes for foreign keys.',
      category: 'database',
    });
    assert.strictEqual(skill1.name, 'postgresql-tuning');
    assert.strictEqual(skill1.category, 'database');

    const skill2 = await skillStore.createSkill({
      name: 'appsec-hardening',
      description: 'OWASP top 10 and secure coding practices.',
      content: 'Validate all inputs with server-side schemas. Never reflect raw user input.',
      category: 'security',
    });

    // 2. List Skills
    const allSkills = await skillStore.listSkills();
    assert.strictEqual(allSkills.length, 2);

    const dbSkills = await skillStore.listSkills('database');
    assert.strictEqual(dbSkills.length, 1);
    assert.strictEqual(dbSkills[0].name, 'postgresql-tuning');

    // 3. Create Agent
    const agent = await agentStore.createAgent({
      name: 'DB Architect',
      role: 'Database Specialist',
      systemPrompt: 'You design and optimize databases.',
    });

    // 4. Mount Skill to Agent
    const mountRes = await skillStore.mountSkillToAgent(agent.id, skill1.id);
    assert.strictEqual(mountRes.mountedSkills.length, 1);
    assert.strictEqual(mountRes.mountedSkills[0], skill1.id);

    // 5. Format Skills Prompt
    const prompt = await skillStore.formatSkillsPrompt(agent.id);
    assert.ok(prompt.includes('## Active Agent Skills'));
    assert.ok(prompt.includes('postgresql-tuning'));
    assert.ok(prompt.includes('EXPLAIN (ANALYZE, BUFFERS)'));

    // 6. Unmount Skill
    const unmountRes = await skillStore.unmountSkillFromAgent(agent.id, skill1.id);
    assert.strictEqual(unmountRes.mountedSkills.length, 0);

    const emptyPrompt = await skillStore.formatSkillsPrompt(agent.id);
    assert.strictEqual(emptyPrompt, '');

    // 7. Delete Skill
    const deleted = await skillStore.deleteSkill(skill1.id);
    assert.strictEqual(deleted, true);
    const remaining = await skillStore.listSkills();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].name, 'appsec-hardening');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
