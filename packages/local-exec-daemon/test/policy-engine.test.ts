import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PolicyEngine, PolicyRule } from '../src/policy-engine.js';
import { LocalExecDaemon } from '../src/daemon.js';

describe('PolicyEngine - Fail-Closed Boundary Governance', () => {
  let tmpDir: string;
  let engine: PolicyEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-policy-test-'));
    engine = new PolicyEngine({ storageDir: tmpDir });
  });

  it('denies access to sensitive credentials and system paths by default', () => {
    const decision1 = engine.evaluate({
      tool: 'read_file',
      args: { path: '/etc/shadow' },
    });
    assert.strictEqual(decision1.action, 'DENY');
    assert.strictEqual(decision1.allowed, false);
    assert.ok(decision1.reason.includes('Sensitive'));

    const decision2 = engine.evaluate({
      tool: 'read_file',
      args: { path: '/Users/test/.ssh/id_rsa' },
    });
    assert.strictEqual(decision2.action, 'DENY');

    const decision3 = engine.evaluate({
      tool: 'write_file',
      args: { path: '/Users/test/project/.env', content: 'SECRET=123' },
    });
    assert.strictEqual(decision3.action, 'DENY');
  });

  it('denies dangerous destructive shell commands by default', () => {
    const decision1 = engine.evaluate({
      tool: 'exec_command',
      args: { command: 'rm -rf /' },
    });
    assert.strictEqual(decision1.action, 'DENY');
    assert.ok(decision1.reason.includes('Destructive'));

    const decision2 = engine.evaluate({
      tool: 'exec_command',
      args: { command: 'sudo apt-get install malware' },
    });
    assert.strictEqual(decision2.action, 'DENY');
  });

  it('allows safe development inspection commands', () => {
    const decision1 = engine.evaluate({
      tool: 'exec_command',
      args: { command: 'git status' },
    });
    assert.strictEqual(decision1.action, 'ALLOW');
    assert.strictEqual(decision1.allowed, true);

    const decision2 = engine.evaluate({
      tool: 'exec_command',
      args: { command: 'pnpm test' },
    });
    assert.strictEqual(decision2.action, 'ALLOW');
  });

  it('records audit log entries for all evaluated decisions', () => {
    engine.evaluate({ tool: 'read_file', args: { path: '/etc/passwd' } });
    engine.evaluate({ tool: 'exec_command', args: { command: 'git status' } });

    const audit = engine.getAuditLog(10);
    assert.strictEqual(audit.length, 2);
    assert.strictEqual(audit[0].tool, 'exec_command'); // Most recent first
    assert.strictEqual(audit[0].decision, 'ALLOW');
    assert.strictEqual(audit[1].tool, 'read_file');
    assert.strictEqual(audit[1].decision, 'DENY');
  });

  it('persists custom rules to disk and reloads them', () => {
    const customRule: PolicyRule = {
      id: 'rule_deny_crypto',
      name: 'Deny Cryptocurrency Tools',
      enabled: true,
      action: 'DENY',
      conditions: {
        commandsRegex: ['\\b(bitcoin|ethereum|monero-miner)\\b'],
      },
    };

    engine.setRule(customRule);

    const reloadedEngine = new PolicyEngine({ storageDir: tmpDir });
    const rule = reloadedEngine.getRule('rule_deny_crypto');
    assert.ok(rule);
    assert.strictEqual(rule?.name, 'Deny Cryptocurrency Tools');

    const decision = reloadedEngine.evaluate({
      tool: 'exec_command',
      args: { command: 'start monero-miner --port 3333' },
    });
    assert.strictEqual(decision.action, 'DENY');
  });

  it('integrates with LocalExecDaemon to block denied tool calls at execution time', async () => {
    const daemon = new LocalExecDaemon({ stateDir: tmpDir });
    await daemon.start();

    try {
      const result = await daemon.executeTool('exec_command', {
        command: 'rm -rf /',
      });

      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.error?.code, 'POLICY_DENIED');
      assert.ok(result.error?.message.includes('Policy Boundary Violation'));
    } finally {
      await daemon.stop();
    }
  });
});
