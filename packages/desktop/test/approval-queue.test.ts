import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Minimal DOM: the renderer module only needs createElement/appendChild/classList.
class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  onclick: (() => Promise<void>) | null = null;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  classList = {
    toggle: (name: string, on: boolean) => {
      if (name === 'hidden') this.hidden = on;
    },
  };
  // The module clears the queue with `innerHTML = ''`; the fake DOM must drop its children too.
  set innerHTML(_html: string) {
    this.children = [];
  }
  get innerHTML(): string {
    return '';
  }
  setAttribute(): void {}
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(__dirname, '../../renderer/modules/chat/approval-queue.js');

interface Queue {
  render(): void;
}

async function loadQueueModule(): Promise<{ createApprovalQueue: (opts: any) => Queue }> {
  assert.ok(fs.existsSync(modulePath), `approval queue module missing at ${modulePath}`);
  return import(pathToFileURL(modulePath).href);
}

function installDocument(): { queue: FakeElement; restore: () => void } {
  const queue = new FakeElement('div');
  const g = globalThis as any;
  const previous = g.document;
  g.document = {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => (id === 'approvalQueue' ? queue : null),
  };
  return { queue, restore: () => { g.document = previous; } };
}

function buttons(card: FakeElement): FakeElement[] {
  const actions = card.children.find((c) => c.className === 'approval-card-actions');
  return actions ? actions.children : [];
}

const actions = [
  ['Approve Once', 'approve_once'],
  ['Always Allow', 'always_allow'],
  ['Reject', 'reject'],
] as const;

for (const [label, action] of actions) {
  test(`approval card - "${label}" reaches approveTool without a render option`, async () => {
    const { createApprovalQueue } = await loadQueueModule();
    const { queue, restore } = installDocument();
    const calls: Array<[string, any]> = [];
    const pendingApprovals = new Map([['appr-1', { toolName: 'exec_command', args: { cmd: 'ls' }, reason: '', epoch: 7 }]]);
    const client = {
      approveTool: async (id: string, decision: any) => {
        calls.push([id, decision]);
        return { success: true };
      },
    };
    try {
      // app.js passes exactly this: no render callback.
      const api = createApprovalQueue({ pendingApprovals, client });
      api.render();
      const button = buttons(queue.children[0]).find((b) => b.textContent === label)!;
      assert.ok(button, `"${label}" button rendered`);
      await button.onclick!();
      assert.deepStrictEqual(calls, [['appr-1', { action, epoch: 7 }]]);
      assert.strictEqual(pendingApprovals.size, 0, 'answered card is removed');
      assert.deepStrictEqual(queue.children, [], 'queue re-rendered after the answer');
    } finally {
      restore();
    }
  });
}

test('approval card - a failed approveTool keeps the card and its buttons', async () => {
  const { createApprovalQueue } = await loadQueueModule();
  const { queue, restore } = installDocument();
  const pendingApprovals = new Map([['appr-2', { toolName: 'exec_command', args: {}, reason: '', epoch: 3 }]]);
  const client = { approveTool: async () => { throw new Error('stale epoch'); } };
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const api = createApprovalQueue({ pendingApprovals, client });
    api.render();
    const [button] = buttons(queue.children[0]);
    await button.onclick!();
    assert.strictEqual(pendingApprovals.size, 1, 'card is not dropped on failure');
    assert.strictEqual(queue.children.length, 1, 'card is re-rendered');
    assert.strictEqual(buttons(queue.children[0])[0].disabled, false, 're-rendered buttons are usable again');
    assert.strictEqual(errors.length, 1, 'failure is not silent');
  } finally {
    console.error = originalError;
    restore();
  }
});

test('approval card - hides "Always Allow" for shell_outside', async () => {
  const { createApprovalQueue } = await loadQueueModule();
  const { queue, restore } = installDocument();
  const pendingApprovals = new Map([
    ['appr-outside', { toolName: 'exec_command', args: { unsandboxed: true }, effect: 'shell_outside', epoch: 1 }],
  ]);
  const client = { approveTool: async () => ({ success: true }) };
  try {
    const api = createApprovalQueue({ pendingApprovals, client });
    api.render();
    const renderedButtons = buttons(queue.children[0]);
    const labels = renderedButtons.map((b) => b.textContent);
    assert.deepStrictEqual(labels, ['Approve Once', 'Reject']);
    assert.strictEqual(renderedButtons.find((b) => b.textContent === 'Always Allow'), undefined);
  } finally {
    restore();
  }
});

test('approval card - hides "Always Allow" for hard-stop effects (control, spend, self)', async () => {
  const { createApprovalQueue } = await loadQueueModule();
  const { queue, restore } = installDocument();
  const hardStops = ['control', 'spend', 'self'] as const;
  try {
    for (const effect of hardStops) {
      const pendingApprovals = new Map([
        [`appr-${effect}`, { toolName: `tool_${effect}`, args: {}, effect, epoch: 1 }],
      ]);
      const client = { approveTool: async () => ({ success: true }) };
      const api = createApprovalQueue({ pendingApprovals, client });
      api.render();
      const renderedButtons = buttons(queue.children[0]);
      const labels = renderedButtons.map((b) => b.textContent);
      assert.deepStrictEqual(labels, ['Approve Once', 'Reject'], `effect "${effect}" must hide Always Allow`);
    }
  } finally {
    restore();
  }
});

test('approval card - hides "Always Allow" when tainted is true', async () => {
  const { createApprovalQueue } = await loadQueueModule();
  const { queue, restore } = installDocument();
  const pendingApprovals = new Map([
    ['appr-tainted', { toolName: 'exec_command', args: { cmd: 'ls' }, effect: 'shell', tainted: true, epoch: 1 }],
  ]);
  const client = { approveTool: async () => ({ success: true }) };
  try {
    const api = createApprovalQueue({ pendingApprovals, client });
    api.render();
    const renderedButtons = buttons(queue.children[0]);
    const labels = renderedButtons.map((b) => b.textContent);
    assert.deepStrictEqual(labels, ['Approve Once', 'Reject']);
  } finally {
    restore();
  }
});

test('approval card - shows "Always Allow" for standard safe effects', async () => {
  const { createApprovalQueue } = await loadQueueModule();
  const { queue, restore } = installDocument();
  const safeEffects = ['read', 'edit', 'shell', 'delegate', 'engine_run', undefined];
  try {
    for (const effect of safeEffects) {
      const pendingApprovals = new Map([
        ['appr-safe', { toolName: 'tool_safe', args: {}, effect, epoch: 1 }],
      ]);
      const client = { approveTool: async () => ({ success: true }) };
      const api = createApprovalQueue({ pendingApprovals, client });
      api.render();
      const renderedButtons = buttons(queue.children[0]);
      const labels = renderedButtons.map((b) => b.textContent);
      assert.deepStrictEqual(labels, ['Approve Once', 'Always Allow', 'Reject'], `effect "${effect}" should show Always Allow`);
    }
  } finally {
    restore();
  }
});
