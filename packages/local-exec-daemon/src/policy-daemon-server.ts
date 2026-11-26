/**
 * Standalone policy daemon. JSON-RPC 2.0 over a local Unix domain socket (or
 * stdio). It never mutates rules from the wire, never accepts policy authority
 * from a caller, and never answers with ALLOW on an error path: every failure
 * resolves to REQUIRE_APPROVAL.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { autoAllows } from '@opensand/shared';
import { PolicyEngine } from './policy-engine.js';
import { canonicalizeArgumentPaths, PathEscapeError } from './path-canonicalizer.js';
import {
  POLICY_RPC_ERRORS, POLICY_RPC_METHOD,
  type PolicyDaemonServerOptions, type PolicyEvaluateParams,
  type PolicyEvaluateResult, type PolicyEvaluateRpcResponse, type PolicyTrustedContext,
} from './types.js';

function failClosedResult(reason: string): PolicyEvaluateResult {
  return {
    action: 'REQUIRE_APPROVAL',
    allowed: false,
    requiresApproval: true,
    reason: `FAIL_CLOSED: ${reason}`,
    effect: 'unknown',
  };
}

function failClosedResponse(id: string | number | null, reason: string, code?: number): PolicyEvaluateRpcResponse {
  const response: PolicyEvaluateRpcResponse = {
    jsonrpc: '2.0',
    id,
    result: failClosedResult(reason),
  };
  if (code !== undefined) response.error = { code, message: reason };
  return response;
}

/** Brief §4.1: `ask` auto-allows read-only effects; shared autoAllows covers auto/auto_edit. */
function daemonAutoAllows(mode: string, req: { effect: string; note?: string; sandboxed?: boolean }): boolean {
  if (mode === 'ask' && req.effect === 'read') return true;
  return autoAllows(mode, req);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class PolicyDaemonServer {
  private readonly policy: PolicyEngine;
  private readonly context: PolicyTrustedContext;
  private readonly authTokenHash: Buffer;
  private readonly authConfigured: boolean;
  private server: net.Server | null = null;
  private socketPath: string | null = null;

  constructor(options: PolicyDaemonServerOptions) {
    this.policy = options.policy ?? new PolicyEngine();
    this.authConfigured = typeof options.authToken === 'string' && options.authToken.length > 0;
    this.authTokenHash = createHash('sha256').update(options.authToken ?? '').digest();
    // A missing context fails closed rather than granting a caller-controlled default.
    this.context = options.context ?? {
      sessionId: 'daemon', approvalMode: 'ask', tainted: true, sandboxed: false,
      cwd: '', workspaceRoot: '', allowlistedHosts: [], declaredEffects: {},
    };
  }

  private authorized(token: unknown): boolean {
    if (!this.authConfigured || typeof token !== 'string') return false;
    // shortcut: shared-secret auth for a single-host socket; upgrade to peer credentials
    // if the socket is ever exposed to other users or containers.
    return timingSafeEqual(this.authTokenHash, createHash('sha256').update(token).digest());
  }

  /** Deterministic, synchronous request handler; also usable directly in tests. */
  public handleRequest(raw: string | Buffer | unknown): PolicyEvaluateRpcResponse {
    let request: unknown = raw;
    if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
      try {
        request = JSON.parse(raw.toString('utf8'));
      } catch {
        return failClosedResponse(null, 'unparseable JSON-RPC payload', POLICY_RPC_ERRORS.PARSE_ERROR);
      }
    }

    if (!isObject(request) || request.jsonrpc !== '2.0') {
      const id = isObject(request) && (typeof request.id === 'string' || typeof request.id === 'number')
        ? request.id : null;
      return failClosedResponse(id, 'invalid JSON-RPC envelope', POLICY_RPC_ERRORS.INVALID_REQUEST);
    }
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    if (!this.authorized(request.authToken)) {
      return failClosedResponse(id, 'unauthorized policy caller', POLICY_RPC_ERRORS.UNAUTHORIZED);
    }
    if (request.method !== POLICY_RPC_METHOD) {
      return failClosedResponse(id, `unsupported method: ${String(request.method)}`, POLICY_RPC_ERRORS.METHOD_NOT_FOUND);
    }

    const params = request.params;
    if (!isObject(params) || !this.validParams(params)) {
      return failClosedResponse(id, 'invalid policy.evaluate params', POLICY_RPC_ERRORS.INVALID_PARAMS);
    }
    // Only tool name and args are caller inputs. Every other field on the wire is
    // ignored: approval mode, taint, sandbox, roots, allowlists, effect and identity
    // all come from the daemon-owned context below.
    const p = params as unknown as PolicyEvaluateParams;
    const context = this.context;

    let canonicalPaths: string[];
    try {
      canonicalPaths = canonicalizeArgumentPaths(p.args, context.workspaceRoot);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return { jsonrpc: '2.0', id, result: {
          action: 'DENY', allowed: false, requiresApproval: false,
          reason: 'Path sandbox violation', effect: 'unknown',
        } };
      }
      return failClosedResponse(id, 'path canonicalization failed', POLICY_RPC_ERRORS.INTERNAL_ERROR);
    }

    try {
      const decision = this.policy.evaluate({
        tool: p.toolName,
        args: p.args,
        actor: context.sessionId,
        initiator: 'user',
        declaredEffect: context.declaredEffects[p.toolName],
        // Wire params never get to opt out of effect-first fail-closed evaluation.
        strictEffects: true,
        tainted: context.tainted,
        sandboxed: context.sandboxed,
        cwd: context.cwd,
        workspaceRoot: context.workspaceRoot,
        allowlistedHosts: context.allowlistedHosts,
      });
      const effect = decision.effect ?? 'unknown';
      if (decision.action === 'DENY') {
        return { jsonrpc: '2.0', id, result: {
          action: 'DENY', allowed: false, requiresApproval: false,
          reason: decision.reason, canonicalPaths, effect,
        } };
      }
      const note = context.tainted ? 'untrusted content was read earlier in this turn' : undefined;
      const auto = daemonAutoAllows(context.approvalMode, { effect, note, sandboxed: context.sandboxed });
      const action = auto && decision.action !== 'REQUIRE_APPROVAL' ? 'ALLOW' : 'REQUIRE_APPROVAL';
      return { jsonrpc: '2.0', id, result: {
        action,
        allowed: action === 'ALLOW',
        requiresApproval: action === 'REQUIRE_APPROVAL',
        reason: action === 'ALLOW' ? decision.reason : `Approval required: ${decision.reason}`,
        canonicalPaths,
        effect,
      } };
    } catch {
      return failClosedResponse(id, 'policy evaluation failed', POLICY_RPC_ERRORS.INTERNAL_ERROR);
    }
  }

  /** Start listening on a Unix domain socket. Stale socket files are replaced. */
  public async listen(socketPath: string): Promise<void> {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    this.socketPath = socketPath;
    const server = net.createServer((socket) => this.wireLineProtocol(socket, socket));
    server.on('error', () => { /* a dropped connection never yields ALLOW */ });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => { server.off('error', onError); reject(err); };
      server.once('error', onError);
      server.listen(socketPath, () => { server.off('error', onError); resolve(); });
    });
  }

  /** Same newline-delimited protocol over standard input/output pipes. */
  public serveStdio(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
    this.wireLineProtocol(input, output);
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
    }
    if (this.socketPath && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    this.socketPath = null;
  }

  private validParams(params: Record<string, unknown>): boolean {
    return typeof params.toolName === 'string'
      && isObject(params.args);
  }

  private wireLineProtocol(source: NodeJS.ReadableStream, sink: NodeJS.WritableStream): void {
    source.setEncoding?.('utf8');
    let buffer = '';
    source.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) sink.write(JSON.stringify(this.handleRequest(line)) + '\n');
        newline = buffer.indexOf('\n');
      }
    });
    source.on('error', () => { /* fail closed by silence; the client times out */ });
  }
}

export { PolicyDaemonServer };
