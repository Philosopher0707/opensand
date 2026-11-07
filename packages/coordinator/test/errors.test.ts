import test from 'node:test';
import assert from 'node:assert';
import { classifyError } from '../src/errors.js';

test('classifyError - correctly categorizes 12 seeded error conditions', () => {
  // 1. Auth / Invalid key
  const authErr = classifyError(new Error('HTTP 401 Unauthorized: Invalid API key provided'));
  assert.strictEqual(authErr.code, 'AUTH_INVALID_KEY');
  assert.ok(authErr.cause.includes('rejected your API key'));
  assert.ok(authErr.nextAction.includes('Settings'));

  // 2. Rate limit (429)
  const rateErr = classifyError(new Error('Rate limit exceeded: please slow down'));
  assert.strictEqual(rateErr.code, 'RATE_LIMIT_EXCEEDED');
  assert.ok(rateErr.cause.includes('rate limit'));

  // 3. Provider down (503)
  const downErr = classifyError({ status: 503, message: 'Service Unavailable: model overloaded' });
  assert.strictEqual(downErr.code, 'PROVIDER_UNAVAILABLE');
  assert.strictEqual(downErr.isUserFixable, false);

  // 4. Ollama unreachable
  const ollamaErr = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
  assert.strictEqual(ollamaErr.code, 'OLLAMA_UNREACHABLE');
  assert.ok(ollamaErr.nextAction.includes('ollama serve'));

  // 5. Network offline
  const netErr = classifyError(new Error('getaddrinfo ENOTFOUND api.anthropic.com'));
  assert.strictEqual(netErr.code, 'NETWORK_OFFLINE');

  // 6. User denied tool
  const denyErr = classifyError(new Error('tool rejected: permission_denied by policy'));
  assert.strictEqual(denyErr.code, 'TOOL_APPROVAL_DENIED');

  // 7. Timeout
  const timeoutErr = classifyError(new Error('Operation timed out after 30000ms'));
  assert.strictEqual(timeoutErr.code, 'EXECUTION_TIMEOUT');

  // 8. File Not Found
  const fnfErr = classifyError(new Error('ENOENT: no such file or directory, open "/tmp/foo.txt"'));
  assert.strictEqual(fnfErr.code, 'FILE_NOT_FOUND');

  // 9. OS Permission Denied
  const permErr = classifyError(new Error('EACCES: permission denied, write "/etc/passwd"'));
  assert.strictEqual(permErr.code, 'FS_PERMISSION_DENIED');

  // 10. Disk full
  const fullErr = classifyError(new Error('ENOSPC: no space left on device'));
  assert.strictEqual(fullErr.code, 'DISK_FULL');

  // 11. Context length
  const ctxErr = classifyError(new Error('Context length exceeded: prompt has 250000 tokens'));
  assert.strictEqual(ctxErr.code, 'CONTEXT_LENGTH_EXCEEDED');

  // 12. State downgrade refused
  const downStateErr = classifyError(new Error('state version downgrade refused: state was created by a newer version of opensand'));
  assert.strictEqual(downStateErr.code, 'STATE_DOWNGRADE_REFUSED');
});
