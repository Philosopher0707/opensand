import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { DesktopIpcBridge } from '../src/ipc-bridge.js';

/**
 * End-to-end delegation over the real code path with a local fake LLM:
 * parent turn → delegate_to_agent tool → child turn → result → parent transcript.
 * No external credentials are used; the fake HTTP server stands in for OpenAI.
 */
test('default assistant delegates to CTO Bot and the child result reaches the parent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-delegation-e2e-'));
  let calls = 0;
  const seenBodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seenBodies.push(body);
      calls += 1;
      let delta: Record<string, unknown>;
      if (calls === 1) {
        // Parent turn issues the delegation tool call.
        delta = {
          tool_calls: [{
            index: 0,
            id: 'call_delegate_cto',
            type: 'function',
            function: {
              name: 'delegate_to_agent',
              arguments: JSON.stringify({
                agent_id_or_name: 'CTO Bot',
                task: 'Research agentic UI/UX patterns',
              }),
            },
          }],
        };
      } else if (calls === 2) {
        // Child turn (CTO Bot) produces its report.
        delta = { content: 'CTO_REPORT_COMPLETE' };
      } else {
        delta = { content: 'PARENT_FINAL_AFTER_DELEGATION' };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const bridge = new DesktopIpcBridge({ baseDir: tmpDir });
  try {
    await bridge.daemon.state.writePermissionGates({ computerUseAllowed: true });
    bridge.updateSettings({
      autoApprove: true,
      provider: 'openai',
      endpoint: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      model: 'e2e-model',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cto = await bridge.createAgent({
      name: 'CTO Bot',
      role: 'Chief Technology Officer',
      systemPrompt: 'You research deeply.',
      model: 'e2e-model',
    });
    assert.ok(cto.id.startsWith('agent_'));

    const events: any[] = [];
    bridge.on('event', (event) => events.push(event));

    // Attach the completion listener BEFORE sending: the fake LLM is fast and
    // can fire turn_complete before an awaited sendQuery returns.
    const completion = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('parent turn did not complete')), 10_000);
      const listener = (event: any) => {
        if (event.type === 'turn_cancelled') {
          clearTimeout(timer);
          bridge.off('event', listener);
          reject(new Error('parent turn was cancelled'));
        }
        if (event.type === 'turn_complete') {
          clearTimeout(timer);
          bridge.off('event', listener);
          resolve(event);
        }
      };
      bridge.on('event', listener);
    });

    const queued = await bridge.sendQuery('Delegate research to the CTO', 'e2e-session');
    assert.strictEqual(queued.sessionId, 'e2e-session');
    await completion;
    assert.ok(calls >= 3, `parent + child + parent continuation must call the LLM (got ${calls})`);

    const subagent = events.find((e) => e.type === 'subagent');
    assert.ok(subagent, 'a subagent event must reach the UI event stream');
    assert.strictEqual(subagent.subagent?.agentName, 'CTO Bot');
    assert.strictEqual(subagent.sessionId, 'e2e-session', 'event must stay on the parent session');

    const completed = events.find((e) => e.type === 'turn_complete');
    assert.ok(completed, 'parent turn must complete');
    assert.match(completed.data?.response || '', /PARENT_FINAL_AFTER_DELEGATION/);

    const childDirs = fs.readdirSync(path.join(tmpDir, 'sessions')).filter((n) => n.startsWith('sub_'));
    assert.ok(childDirs.length >= 1, 'child coordinator must persist its own transcript');
  } finally {
    await bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
