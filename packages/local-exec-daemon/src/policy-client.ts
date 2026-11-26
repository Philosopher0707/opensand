/**
 * Structured client for the isolated policy daemon. Every transport failure
 * (unreachable socket, timeout, disconnect, malformed or contradictory reply)
 * resolves to a fail-closed REQUIRE_APPROVAL — never to ALLOW.
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A reply is trusted only if every required field is present and self-consistent. */
function validResult(value: unknown): value is PolicyEvaluateResult {
  if (!isObject(value)) return false;
  const { action, allowed, requiresApproval, reason, effect, canonicalPaths } = value;
  if (typeof reason !== 'string' || typeof effect !== 'string') return false;
  if (typeof allowed !== 'boolean' || typeof requiresApproval !== 'boolean') return false;
  if (canonicalPaths !== undefined
    && (!Array.isArray(canonicalPaths) || !canonicalPaths.every((p) => typeof p === 'string'))) return false;
  if (action === 'ALLOW') return allowed === true && requiresApproval === false;
  if (action === 'DENY') return allowed === false && requiresApproval === false;
  if (action === 'REQUIRE_APPROVAL') return allowed === false && requiresApproval === true;
  return false;
}

class PolicyClient {
  readonly socketPath: string;
  readonly timeoutMs: number;
  private readonly authToken: string;

  constructor(options: PolicyClientOptions) {
    this.socketPath = options.socketPath;
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? POLICY_RPC_TIMEOUT_MS;
  }

  public evaluate(params: PolicyEvaluateParams): Promise<PolicyEvaluateResult> {
    const id = `policy-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const request: Request = {
      jsonrpc: '2.0', id, method: POLICY_RPC_METHOD,
      authToken: this.authToken,
      // Only untrusted inputs go on the wire; the daemon owns the policy context.
      params: { toolName: params.toolName, args: params.args },
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
        let reply: unknown;
        try {
          reply = JSON.parse(line);
        } catch {
          socket.destroy();
          fail('unparseable reply');
          return;
        }
        socket.end();
        if (!isObject(reply) || reply.jsonrpc !== '2.0') {
          fail('invalid reply envelope');
        } else if (reply.id !== id) {
          fail('reply id mismatch');
        } else if (!validResult(reply.result)) {
          fail('invalid or contradictory policy result');
        } else {
          settled = true;
          resolve(reply.result);
        }
      });
      // OS errors can contain absolute paths; publish only a stable reason.
      socket.on('error', () => fail('connection error'));
      socket.on('close', () => fail('daemon disconnected before replying'));
    });
  }
}

export { PolicyClient };
