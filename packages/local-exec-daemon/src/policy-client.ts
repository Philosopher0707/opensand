/**
 * Structured client for the isolated policy daemon. Every transport failure
 * (unreachable socket, timeout, disconnect, malformed reply) resolves to a
 * fail-closed REQUIRE_APPROVAL — never to ALLOW.
 */
import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  POLICY_RPC_METHOD, POLICY_RPC_TIMEOUT_MS,
  type PolicyClientOptions, type PolicyEvaluateParams,
  type PolicyEvaluateResult, type PolicyEvaluateRpcRequest,
} from './types.js';

// Alias kept local so the public name stays short at the call site.
type Request = PolicyEvaluateRpcRequest & { params: PolicyEvaluateParams };

class PolicyClient {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(options: PolicyClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? POLICY_RPC_TIMEOUT_MS;
  }

  public evaluate(params: PolicyEvaluateParams): Promise<PolicyEvaluateResult> {
    const id = `policy-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const request: Request = {
      jsonrpc: '2.0', id, method: POLICY_RPC_METHOD,
      params: { ...params, strictEffects: true },
    };

    return new Promise((resolve) => {
      let settled = false;
      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        resolve({
          action: 'REQUIRE_APPROVAL',
          allowed: false,
          requiresApproval: true,
          reason: `DAEMON_UNAVAILABLE: ${reason}`,
          effect: 'unknown',
        });
      };

      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        fail(`timed out after ${this.timeoutMs}ms`);
      });
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        let reply: { id?: unknown; result?: PolicyEvaluateResult; error?: { message?: string } };
        try {
          reply = JSON.parse(line);
        } catch {
          socket.destroy();
          fail('unparseable reply');
          return;
        }
        socket.end();
        if (reply.id !== id) {
          fail('reply id mismatch');
        } else if (!reply.result) {
          fail(`daemon error: ${reply.error?.message ?? 'no result'}`);
        } else {
          settled = true;
          resolve(reply.result);
        }
      });
      socket.on('error', (err) => fail(err.message));
      socket.on('close', () => fail('daemon disconnected before replying'));
    });
  }
}

export { PolicyClient };
