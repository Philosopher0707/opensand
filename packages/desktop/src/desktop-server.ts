import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DesktopIpcBridge } from './ipc-bridge.js';
import { createDefaultRpcGateway, RpcGateway } from './rpc-gateway.js';
import { handleAgUiRunRequest, AgUiEventPayload, defaultOpenRouterCatalog, AnthropicClient } from '@opensand/coordinator';
import type { DesktopEvent, ApprovalDecision, DesktopSettings } from './types.js';
import { runStateMigrations, readSchemaVersion } from '@opensand/shared';
import { buildDiagnosticsReport } from './diagnostics.js';
import { getOnboardingState, probeOllama, OLLAMA_CHAT_ENDPOINT } from './onboarding.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DesktopServerOptions {
  port?: number;
  host?: string;
  baseDir?: string;
  authToken?: string;
  requireAuth?: boolean;
  webhookMaxRequestsPerMinute?: number;
  appVersion?: string;
}

/**
 * OpenSand Desktop HTTP & SSE Server
 *
 * Security Model:
 * - Server binds to localhost (127.0.0.1) by default.
 * - Enforces Host header validation and Origin check to prevent DNS rebinding and cross-site request forgery.
 * - All administrative API, RPC, and AG-UI routes require token authentication (Bearer header,
 *   X-OpenSand-Token, or opensand_token session cookie).
 * - The session authentication token (authToken) is equivalent to an administrative password for the
 *   OpenSand instance. Anyone possessing this token can create sessions, configure settings, and inspect agents.
 *   The token is stored in ~/.opensand/server.token with 0o600 permissions.
 * - Query parameter authentication (?token=...) is strictly restricted to initial page bootstrap (GET /)
 *   and native browser EventSource connections (GET /api/events, which cannot set custom HTTP headers).
 * - Client applications can exchange the token via POST /api/auth/token-exchange to obtain a secure HttpOnly cookie.
 * - Webhook ingestion (POST /api/webhooks/:name) is protected by per-IP rate limiting and signature verification.
 */
export class DesktopServer {
  private server: http.Server | null = null;
  private bridge: DesktopIpcBridge;
  private rpcGateway: RpcGateway;
  private sseClients: Set<http.ServerResponse> = new Set();
  private rendererDir: string;
  private port: number;
  private host: string;
  private baseDir: string;
  private authToken: string;
  private tokenFilePath: string;
  private requireAuth: boolean;
  private webhookRateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private webhookMaxRequestsPerMinute: number;
  private appVersion: string;

  constructor(options: DesktopServerOptions = {}) {
    this.port = options.port ?? 3456;
    this.host = options.host || '127.0.0.1';
    this.baseDir = options.baseDir || path.join(os.homedir(), '.opensand');
    this.tokenFilePath = path.join(this.baseDir, 'server.token');
    this.requireAuth = options.requireAuth ?? true;
    this.webhookMaxRequestsPerMinute = options.webhookMaxRequestsPerMinute ?? 60;
    this.appVersion = options.appVersion ?? '0.1.0';

    // Resolve or generate session authentication token
    let shouldWriteTokenFile = false;
    if (options.authToken) {
      this.authToken = options.authToken;
    } else {
      try {
        if (fs.existsSync(this.tokenFilePath)) {
          const raw = fs.readFileSync(this.tokenFilePath, 'utf8').trim();
          if (raw.length >= 32) {
            this.authToken = raw;
          } else {
            this.authToken = crypto.randomBytes(32).toString('hex');
            shouldWriteTokenFile = true;
          }
        } else {
          this.authToken = crypto.randomBytes(32).toString('hex');
          shouldWriteTokenFile = true;
        }
      } catch {
        this.authToken = crypto.randomBytes(32).toString('hex');
        shouldWriteTokenFile = true;
      }
    }

    if (shouldWriteTokenFile) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.tokenFilePath, this.authToken + '\n', { mode: 0o600 });
      } catch {
        // Best effort
      }
    }

    const migration = runStateMigrations(path.join(this.baseDir, 'state'));
    if (migration.migrated) {
      console.log(
        `[OpenSand] state schema v${migration.from} -> v${migration.to}` +
          (migration.backupDir ? ` (backup: ${migration.backupDir})` : ''),
      );
    }

    this.bridge = new DesktopIpcBridge({ baseDir: options.baseDir });
    this.rpcGateway = createDefaultRpcGateway(this.bridge);
    this.rendererDir = path.join(__dirname, '../../renderer');

    // Forward bridge events to SSE clients
    this.bridge.on('event', (event: DesktopEvent) => {
      this.broadcastSse(event);
    });
  }

  public getBridge(): DesktopIpcBridge {
    return this.bridge;
  }

  public getRpcGateway(): RpcGateway {
    return this.rpcGateway;
  }

  public getAuthToken(): string {
    return this.authToken;
  }

  public verifyToken(provided?: string | null): boolean {
    if (!provided || typeof provided !== 'string') return false;
    const clean = provided.trim();
    if (!clean) return false;
    const bufA = crypto.createHash('sha256').update(clean).digest();
    const bufB = crypto.createHash('sha256').update(this.authToken).digest();
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private extractToken(req: http.IncomingMessage, url: URL): string | null {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      return authHeader.slice(7).trim();
    }
    const customHeader = req.headers['x-opensand-token'];
    if (typeof customHeader === 'string' && customHeader.trim()) {
      return customHeader.trim();
    }
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)opensand_token=([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    // Only permit query-parameter token on initial page load (GET /, /index.html, /welcome)
    // or browser EventSource SSE endpoint (GET /api/events where EventSource cannot set headers).
    const isAllowedQueryRoute =
      (url.pathname === '/' ||
        url.pathname === '/index.html' ||
        url.pathname === '/welcome' ||
        url.pathname === '/api/events') &&
      req.method === 'GET';
    if (isAllowedQueryRoute) {
      const queryToken = url.searchParams.get('token');
      if (queryToken && queryToken.trim()) {
        return queryToken.trim();
      }
    }
    return null;
  }

  private checkWebhookRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowMs = 60000;

    // Prune stale entries if map gets large
    if (this.webhookRateLimits.size > 1000) {
      for (const [key, record] of this.webhookRateLimits.entries()) {
        if (now > record.resetAt) {
          this.webhookRateLimits.delete(key);
        }
      }
    }

    const record = this.webhookRateLimits.get(ip);
    if (!record || now > record.resetAt) {
      this.webhookRateLimits.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (record.count >= this.webhookMaxRequestsPerMinute) {
      return false;
    }

    record.count++;
    return true;
  }

  public async start(): Promise<{ port: number; host: string; url: string }> {
    await this.bridge.connectorManager.ensureLoaded();
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });

      // HTTP timeouts to mitigate slowloris & hanging sockets
      server.requestTimeout = 30000;
      server.headersTimeout = 35000;
      server.keepAliveTimeout = 5000;

      server.on('error', (err) => reject(err));

      server.listen(this.port, this.host, () => {
        this.server = server;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.port = actualPort;
        const url = `http://${this.host}:${actualPort}/?token=${this.authToken}`;
        resolve({ port: actualPort, host: this.host, url });
      });
    });
  }

  public async stop(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();

    if (this.server) {
      return new Promise((resolve) => {
        this.server?.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  private broadcastSse(event: DesktopEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    const hostHeader = (req.headers['host'] || '').toLowerCase();
    const originHeader = req.headers['origin'];

    // Security headers (nosniff, framing, referrer, and CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:;"
    );

    // Host header validation to prevent DNS rebinding (fail closed)
    if (!hostHeader) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request: missing Host header' }));
      return;
    }
    const hostname = hostHeader.split(':')[0];
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Access forbidden: invalid Host header' }));
      return;
    }

    // Origin header validation to prevent cross-origin drive-by attacks from arbitrary websites
    if (originHeader) {
      try {
        const originUrl = new URL(originHeader);
        if (originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost') {
          res.setHeader('Access-Control-Allow-Origin', originHeader);
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cross-origin request denied' }));
          return;
        }
      } catch {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed Origin header' }));
        return;
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', `http://${this.host}:${this.port}`);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OpenSand-Token');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authentication Middleware
    const token = this.extractToken(req, url);
    const isStaticAsset = !pathname.startsWith('/api/') && !pathname.startsWith('/aiserver.') && !pathname.startsWith('/ag-ui/');
    const isWebhookIngress = pathname.startsWith('/api/webhooks/') && req.method === 'POST' && pathname !== '/api/webhooks';
    const isTokenExchange = pathname === '/api/auth/token-exchange' && req.method === 'POST';

    // If accessing root or welcome with a valid ?token=..., set session cookie
    if ((pathname === '/' || pathname === '/index.html' || pathname === '/welcome') && token && this.verifyToken(token)) {
      res.setHeader('Set-Cookie', `opensand_token=${this.authToken}; Path=/; SameSite=Strict; HttpOnly`);
    }

    if (this.requireAuth && !isStaticAsset && !isWebhookIngress && !isTokenExchange) {
      if (!this.verifyToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid authorization token' }));
        return;
      }
    }

    const isValidId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

    // API: POST /api/auth/token-exchange (Exchange raw token for session cookie without putting it in URL)
    if (pathname === '/api/auth/token-exchange' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const tokenCandidate = body?.token;
      if (!this.verifyToken(tokenCandidate)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid token' }));
        return;
      }
      res.setHeader('Set-Cookie', `opensand_token=${this.authToken}; Path=/; SameSite=Strict; HttpOnly`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // SSE event stream: /api/events
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(': keep-alive\n\n');
      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // Clean-Room Unified RPC Gateway: POST /aiserver.v1.<ServiceName>/<MethodName>
    if (pathname.startsWith('/aiserver.v1.') && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const handled = await this.rpcGateway.handleHttpRequest(req, res, body);
      if (handled) return;
    }

    // API: POST /api/query
    if (pathname === '/api/query' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const result = await this.bridge.sendQuery(body.query, body.sessionId, body.agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: POST /api/cancel
    if (pathname === '/api/cancel' && req.method === 'POST') {
      const result = await this.bridge.cancelTurn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: POST /api/approve
    if (pathname === '/api/approve' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const result = await this.bridge.approveTool(body.approvalId, body.decision);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: GET /api/approvals (read-only pending-approval queue)
    if (pathname === '/api/approvals' && req.method === 'GET') {
      const approvals = await this.bridge.listPendingApprovals();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(approvals));
      return;
    }

    // API: GET /api/tools (read-only live tool discovery)
    if (pathname === '/api/tools' && req.method === 'GET') {
      const discovery = await this.bridge.getToolDiscovery();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(discovery));
      return;
    }

    // API: GET /api/sessions
    // API: GET /api/sessions/search
    if (pathname === '/api/sessions/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const results = await this.bridge.searchSessions(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
      return;
    }

    // API: GET /api/sessions/:id/export
    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/export') && req.method === 'GET') {
      const rawId = pathname.slice('/api/sessions/'.length, -('/export'.length));
      const sessionId = decodeURIComponent(rawId);
      if (!isValidId(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid sessionId format' }));
        return;
      }
      const format = (url.searchParams.get('format') || 'json') as 'json' | 'md';
      try {
        const exported = await this.bridge.exportSession(sessionId, format);
        const contentType = format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(exported);
      } catch (err: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Session export failed' }));
      }
      return;
    }

    // API: PATCH /api/sessions/:id (Rename session)
    if (pathname.startsWith('/api/sessions/') && req.method === 'PATCH') {
      const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', ''));
      if (!isValidId(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid sessionId format' }));
        return;
      }
      const body = await this.readJsonBody(req);
      if (!body.title || typeof body.title !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid title' }));
        return;
      }
      const success = await this.bridge.renameSession(sessionId, body.title);
      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success }));
      return;
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = await this.bridge.getSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // API: GET /api/sessions/:id
    if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
      const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', ''));
      if (!isValidId(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid sessionId format' }));
        return;
      }
      const data = await this.bridge.loadSession(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    // API: DELETE /api/sessions/:id (Delete individual session)
    if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', ''));
      if (!isValidId(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid sessionId format' }));
        return;
      }
      const deleted = await this.bridge.deleteSession(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: DELETE /api/sessions (Clear all sessions)
    if (pathname === '/api/sessions' && req.method === 'DELETE') {
      const count = await this.bridge.clearAllSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count }));
      return;
    }

    // API: GET /api/settings
    if (pathname === '/api/settings' && req.method === 'GET') {
      const settings = await this.bridge.getSanitizedSettingsResolved();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settings));
      return;
    }

    // API: POST /api/settings
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      this.bridge.updateSettings(body);
      const updated = await this.bridge.getSanitizedSettingsResolved();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
      return;
    }

    // API: GET /api/diagnostics (redacted support report)
    if (pathname === '/api/diagnostics' && req.method === 'GET') {
      const report = buildDiagnosticsReport({
        baseDir: this.baseDir,
        settings: await this.bridge.getSanitizedSettingsResolved(),
        stateVersion: readSchemaVersion(path.join(this.baseDir, 'state')),
        appVersion: this.appVersion,
        electronVersion: process.versions.electron,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }

    // API: GET /api/onboarding (first-run state: local model or key required)
    if (pathname === '/api/onboarding' && req.method === 'GET') {
      const state = await getOnboardingState(this.bridge);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    // API: POST /api/onboarding (pick a local model or store an API key)
    if (pathname === '/api/onboarding' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const mode = body?.mode;

      if (mode === 'ollama') {
        const probe = await probeOllama();
        if (!probe.available) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ollama is not answering on 127.0.0.1:11434' }));
          return;
        }
        const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : probe.models[0];
        if (!model) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No local model found. Run: ollama pull llama3.1' }));
          return;
        }
        this.bridge.updateSettings({
          endpoint: OLLAMA_CHAT_ENDPOINT,
          model,
          apiKey: 'none',
          provider: 'openai',
        });
      } else if (mode === 'key') {
        const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        if (!/^https?:\/\//.test(endpoint) || !model || !apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Endpoint (http/https), model and API key are required' }));
          return;
        }
        this.bridge.updateSettings({ endpoint, model, apiKey, provider: 'openai' });
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mode must be "ollama" or "key"' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, settings: this.bridge.getSanitizedSettings() }));
      return;
    }

    // API: GET /api/agents (List all registered bots)
    if (pathname === '/api/agents' && req.method === 'GET') {
      const agents = await this.bridge.getAgents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agents));
      return;
    }

    // API: POST /api/agents (Create new bot)
    if (pathname === '/api/agents' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const created = await this.bridge.createAgent(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(created));
      return;
    }

    // API: DELETE /api/agents/:id
    if (pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
      const agentId = pathname.replace('/api/agents/', '');
      if (!isValidId(agentId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid agentId format' }));
        return;
      }
      const deleted = await this.bridge.deleteAgent(agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/tasks (List tasks)
    if (pathname === '/api/tasks' && req.method === 'GET') {
      const status = url.searchParams.get('status') as any || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const tasks = await this.bridge.getTasks({ status, agentId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tasks));
      return;
    }

    // API: POST /api/tasks (Create task)
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const task = await this.bridge.createTask(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // API: PUT /api/tasks/:id (Update task)
    if (pathname.startsWith('/api/tasks/') && req.method === 'PUT') {
      const taskId = pathname.replace('/api/tasks/', '');
      if (!isValidId(taskId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid taskId format' }));
        return;
      }
      const body = await this.readJsonBody(req);
      const updated = await this.bridge.updateTask(taskId, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
      return;
    }

    // API: DELETE /api/tasks/:id
    if (pathname.startsWith('/api/tasks/') && req.method === 'DELETE') {
      const taskId = pathname.replace('/api/tasks/', '');
      if (!isValidId(taskId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid taskId format' }));
        return;
      }
      const deleted = await this.bridge.deleteTask(taskId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/learned-rules
    if (pathname === '/api/learned-rules' && req.method === 'GET') {
      const markdown = await this.bridge.getLearnedRules();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ markdown }));
      return;
    }

    // API: POST /api/learned-rules/refresh
    if (pathname === '/api/learned-rules/refresh' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const report = await this.bridge.refreshLearnedRules(body.maxChats ?? 50);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }

    // API: GET /api/memories (List discrete memory facts)
    if (pathname === '/api/memories' && req.method === 'GET') {
      const scope = url.searchParams.get('scope') as any || undefined;
      const tier = url.searchParams.get('tier') as any || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const query = url.searchParams.get('query') || undefined;
      const memories = await this.bridge.listMemories({ scope, tier, agentId, query });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(memories));
      return;
    }

    // API: POST /api/memories (Add memory or import memory batch)
    if (pathname === '/api/memories' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (typeof body.importText === 'string') {
        const importRes = await this.bridge.importMemoryText(body.importText, body.scope, body.agentId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(importRes));
        return;
      }
      const fact = await this.bridge.addMemory(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fact));
      return;
    }

    // API: DELETE /api/memories/:id (Forget memory fact)
    if (pathname.startsWith('/api/memories/') && req.method === 'DELETE') {
      const factId = pathname.replace('/api/memories/', '');
      if (!isValidId(factId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid factId format' }));
        return;
      }
      const scope = url.searchParams.get('scope') as any || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const forgotten = await this.bridge.forgetMemory(factId, scope, agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: forgotten }));
      return;
    }

    // API: POST /api/memories/promote (Promote user memories to team)
    if (pathname === '/api/memories/promote' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const promoteRes = await this.bridge.promoteMemoriesToTeam(body.agentId || 'default', body.factIds || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(promoteRes));
      return;
    }

    // API: GET /api/team-summary (Get team context summary & prose)
    if (pathname === '/api/team-summary' && req.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const summary = await this.bridge.getTeamContextSummary(agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
      return;
    }

    // API: GET /api/team-review (List review items)
    if (pathname === '/api/team-review' && req.method === 'GET') {
      const status = url.searchParams.get('status') as any || undefined;
      const limitStr = url.searchParams.get('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;
      const items = await this.bridge.listReviewItems({ status, limit });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items));
      return;
    }

    // API: POST /api/team-review/resolve (Approve or reject review item)
    if (pathname === '/api/team-review/resolve' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.itemId || !body.decision) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing itemId or decision' }));
        return;
      }
      const item = await this.bridge.resolveReviewItem(body.itemId, body.decision, body.reviewerId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
      return;
    }

    // API: GET /api/vault/secrets
    if (pathname === '/api/vault/secrets' && req.method === 'GET') {
      const secrets = await this.bridge.listSecrets();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(secrets));
      return;
    }

    // API: POST /api/vault/secrets
    if (pathname === '/api/vault/secrets' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.name || !body.value) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing secret name or value' }));
        return;
      }
      const secret = await this.bridge.putSecret(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(secret));
      return;
    }

    // API: DELETE /api/vault/secrets/:id
    if (pathname.startsWith('/api/vault/secrets/') && req.method === 'DELETE') {
      const idOrName = pathname.replace('/api/vault/secrets/', '');
      const deleted = await this.bridge.deleteSecret(idOrName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/vault/credentials
    if (pathname === '/api/vault/credentials' && req.method === 'GET') {
      const kind = url.searchParams.get('kind') || undefined;
      const creds = await this.bridge.listCredentials({ kind });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(creds));
      return;
    }

    // API: POST /api/vault/credentials
    if (pathname === '/api/vault/credentials' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.title || !body.username) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing credential title or username' }));
        return;
      }
      const cred = await this.bridge.putCredential(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cred));
      return;
    }

    // API: DELETE /api/vault/credentials/:id
    if (pathname.startsWith('/api/vault/credentials/') && req.method === 'DELETE') {
      const idOrTitle = pathname.replace('/api/vault/credentials/', '');
      const deleted = await this.bridge.deleteCredential(idOrTitle);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/skills
    if (pathname === '/api/skills' && req.method === 'GET') {
      const category = url.searchParams.get('category') || undefined;
      const skills = await this.bridge.listSkills(category);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(skills));
      return;
    }

    // API: POST /api/skills
    if (pathname === '/api/skills' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.name || !body.description || !body.content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing name, description, or content' }));
        return;
      }
      const skill = await this.bridge.createSkill(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(skill));
      return;
    }

    // API: POST /api/skills/mount
    if (pathname === '/api/skills/mount' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.agentId || !body.skillId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing agentId or skillId' }));
        return;
      }
      const mounted = await this.bridge.mountSkill(body.agentId, body.skillId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mounted));
      return;
    }

    // API: POST /api/skills/unmount
    if (pathname === '/api/skills/unmount' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.agentId || !body.skillId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing agentId or skillId' }));
        return;
      }
      const unmounted = await this.bridge.unmountSkill(body.agentId, body.skillId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(unmounted));
      return;
    }

    // API: DELETE /api/skills/:id
    if (pathname.startsWith('/api/skills/') && req.method === 'DELETE') {
      const skillId = pathname.replace('/api/skills/', '');
      const deleted = await this.bridge.deleteSkill(skillId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/routines
    if (pathname === '/api/routines' && req.method === 'GET') {
      const routines = await this.bridge.listRoutines();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routines));
      return;
    }

    // API: POST /api/routines
    if (pathname === '/api/routines' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.name || !body.prompt || !body.scheduleType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing name, prompt, or scheduleType' }));
        return;
      }
      const routine = await this.bridge.createRoutine(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routine));
      return;
    }

    // API: PATCH /api/routines/:id/enabled
    if (pathname.startsWith('/api/routines/') && pathname.endsWith('/enabled') && req.method === 'PATCH') {
      const routineId = pathname.replace('/api/routines/', '').replace('/enabled', '');
      const body = await this.readJsonBody(req);
      const isEnabled = Boolean(body.isEnabled);
      const routine = await this.bridge.setRoutineEnabled(routineId, isEnabled);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routine));
      return;
    }

    // API: POST /api/routines/:id/trigger
    if (pathname.startsWith('/api/routines/') && pathname.endsWith('/trigger') && req.method === 'POST') {
      const routineId = pathname.replace('/api/routines/', '').replace('/trigger', '');
      const resData = await this.bridge.triggerRoutine(routineId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resData));
      return;
    }

    // API: GET /api/routines/:id/logs
    if (pathname.startsWith('/api/routines/') && pathname.endsWith('/logs') && req.method === 'GET') {
      const routineId = pathname.replace('/api/routines/', '').replace('/logs', '');
      const logs = await this.bridge.getRoutineLogs(routineId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs));
      return;
    }

    // API: DELETE /api/routines/:id
    if (pathname.startsWith('/api/routines/') && req.method === 'DELETE') {
      const routineId = pathname.replace('/api/routines/', '');
      const deleted = await this.bridge.deleteRoutine(routineId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/rooms
    if (pathname === '/api/rooms' && req.method === 'GET') {
      const rooms = await this.bridge.listRooms();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rooms));
      return;
    }

    // API: POST /api/rooms
    if (pathname === '/api/rooms' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.name || !body.description || !Array.isArray(body.memberAgentIds)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing name, description, or memberAgentIds array' }));
        return;
      }
      const room = await this.bridge.createRoom(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(room));
      return;
    }

    // API: GET /api/rooms/:id
    if (pathname.startsWith('/api/rooms/') && !pathname.includes('/members') && !pathname.includes('/discuss') && req.method === 'GET') {
      const roomId = pathname.replace('/api/rooms/', '');
      const room = await this.bridge.getRoom(roomId);
      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Room not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(room));
      return;
    }

    // API: PUT /api/rooms/:id/members
    if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/members') && req.method === 'PUT') {
      const roomId = pathname.replace('/api/rooms/', '').replace('/members', '');
      const body = await this.readJsonBody(req);
      if (!Array.isArray(body.memberAgentIds)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing memberAgentIds array' }));
        return;
      }
      const room = await this.bridge.setRoomMembers(roomId, body.memberAgentIds);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(room));
      return;
    }

    // API: POST /api/rooms/:id/discuss
    if (pathname.startsWith('/api/rooms/') && pathname.endsWith('/discuss') && req.method === 'POST') {
      const roomId = pathname.replace('/api/rooms/', '').replace('/discuss', '');
      const body = await this.readJsonBody(req);
      if (!body.topic) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing topic' }));
        return;
      }
      const discResult = await this.bridge.runRoomDiscussion(roomId, body.topic);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(discResult));
      return;
    }

    // API: DELETE /api/rooms/:id
    if (pathname.startsWith('/api/rooms/') && req.method === 'DELETE') {
      const roomId = pathname.replace('/api/rooms/', '');
      const deleted = await this.bridge.deleteRoom(roomId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/attachments (Grok Bot Parity: List attachments)
    if (pathname === '/api/attachments' && req.method === 'GET') {
      const list = await this.bridge.listAttachments();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    // API: POST /api/attachments (Grok Bot Parity: Stage attachment)
    if (pathname === '/api/attachments' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing filePath' }));
        return;
      }
      try {
        const att = await this.bridge.stageAttachment(body.filePath);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(att));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: DELETE /api/attachments/:id
    if (pathname.startsWith('/api/attachments/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/attachments/', '');
      const deleted = await this.bridge.deleteAttachment(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/templates/:agentId (Grok Bot Parity: Export template)
    if (pathname.startsWith('/api/templates/') && req.method === 'GET') {
      const agentId = pathname.replace('/api/templates/', '');
      try {
        const tpl = await this.bridge.exportAgentTemplate(agentId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tpl));
      } catch (err: any) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: POST /api/templates/import (Grok Bot Parity: Import template)
    if (pathname === '/api/templates/import' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      try {
        const agent = await this.bridge.importAgentTemplate(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agent));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: POST /api/btw (Grok Bot Parity: Glass BTW side question)
    if (pathname === '/api/btw' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.question) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing question' }));
        return;
      }
      try {
        const answer = await this.bridge.askSideQuestion(body.question);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: POST /api/rollback (Grok Bot Parity: RollBackGrokBotConversation)
    if (pathname === '/api/rollback' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const turns = typeof body.turns === 'number' ? body.turns : 1;
      try {
        const result = await this.bridge.rollbackTurns(turns);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: POST /api/compact (Context Window Auto-Compaction)
    if (pathname === '/api/compact' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const keep = typeof body.keepRecentTurns === 'number' ? body.keepRecentTurns : 2;
      try {
        const result = await this.bridge.compactHistory(keep);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: GET /api/tokens (Context Window & Token Telemetry)
    if (pathname === '/api/tokens' && req.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const telemetry = await this.bridge.getTokenTelemetry(agentId, sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(telemetry));
      return;
    }

    // API: GET /api/models (List available models from provider/catalog)
    if (pathname === '/api/models' && req.method === 'GET') {
      const provider = url.searchParams.get('provider') || this.bridge.getSettings().provider;
      const endpoint = url.searchParams.get('endpoint') || this.bridge.getSettings().endpoint;
      await this.bridge.ensureApiKeyResolved();
      const apiKey = this.bridge.getSettings().apiKey;

      try {
        if (provider === 'anthropic' || endpoint?.includes('anthropic.com')) {
          const client = new AnthropicClient();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: client.listModels() }));
          return;
        }

        const models = await defaultOpenRouterCatalog.fetchModels(endpoint, apiKey);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models }));
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [], error: err.message }));
      }
      return;
    }

    // API: GET /api/sentinels (Frontier 2: List active Sentinel workspace watchers)
    if (pathname === '/api/sentinels' && req.method === 'GET') {
      const watchers = this.bridge.getWatchers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(watchers));
      return;
    }

    // API: POST /api/sentinels (Frontier 2: Start new Sentinel workspace watcher)
    if (pathname === '/api/sentinels' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.targetDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing targetDir' }));
        return;
      }
      try {
        const watcher = await this.bridge.startWatcher(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(watcher));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: DELETE /api/sentinels/:id (Frontier 2: Stop active Sentinel watcher)
    if (pathname.startsWith('/api/sentinels/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/sentinels/', '');
      const stopped = this.bridge.stopWatcher(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: stopped }));
      return;
    }

    // API: GET /api/sentinels/logs (Frontier 2: Get Sentinel diagnostic logs)
    if (pathname === '/api/sentinels/logs' && req.method === 'GET') {
      const watcherId = url.searchParams.get('watcherId') || undefined;
      const logs = this.bridge.getSentinelLogs(watcherId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs));
      return;
    }

    // API: GET /api/policies (Boundaries parity)
    if (pathname === '/api/policies' && req.method === 'GET') {
      const policies = this.bridge.getPolicies();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(policies));
      return;
    }

    // API: POST /api/policies
    if (pathname === '/api/policies' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      this.bridge.setPolicy(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: DELETE /api/policies/:id
    if (pathname.startsWith('/api/policies/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/policies/', '');
      const deleted = this.bridge.deletePolicy(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: GET /api/policies/audit
    if (pathname === '/api/policies/audit' && req.method === 'GET') {
      const audit = this.bridge.getPolicyAudit();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(audit));
      return;
    }

    // API: GET /api/webhooks
    if (pathname === '/api/webhooks' && req.method === 'GET') {
      const webhooks = this.bridge.getWebhooks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(webhooks));
      return;
    }

    // API: POST /api/webhooks (Register webhook)
    if (pathname === '/api/webhooks' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const reg = this.bridge.registerWebhook(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reg));
      return;
    }

    // API: GET /api/webhooks/deliveries
    if (pathname === '/api/webhooks/deliveries' && req.method === 'GET') {
      const deliveries = this.bridge.getWebhookDeliveries();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(deliveries));
      return;
    }

    // API: DELETE /api/webhooks/:name
    if (pathname.startsWith('/api/webhooks/') && req.method === 'DELETE') {
      const name = pathname.replace('/api/webhooks/', '');
      const deleted = this.bridge.deleteWebhook(name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted }));
      return;
    }

    // API: POST /api/webhooks/:name (External webhook trigger ingestion)
    if (pathname.startsWith('/api/webhooks/') && req.method === 'POST') {
      const clientIp = (req.socket && req.socket.remoteAddress) || '127.0.0.1';
      if (!this.checkWebhookRateLimit(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too many requests: webhook ingress rate limit exceeded' }));
        return;
      }
      const name = pathname.replace('/api/webhooks/', '');
      const body = await this.readJsonBody(req);
      const result = await this.bridge.handleWebhook(name, body, req.headers as Record<string, string>);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: GET /api/graphs (State Graphs & Cyclical Loops)
    if (pathname === '/api/graphs' && req.method === 'GET') {
      const graphs = this.bridge.getAvailableGraphs();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(graphs));
      return;
    }

    // API: POST /api/graphs/:id/run
    if (pathname.startsWith('/api/graphs/') && pathname.endsWith('/run') && req.method === 'POST') {
      const graphId = pathname.replace('/api/graphs/', '').replace('/run', '');
      const body = await this.readJsonBody(req);
      const result = await this.bridge.runGraph(graphId, body.task);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Universal AG-UI Protocol: POST /ag-ui/v1/run
    if (pathname === '/ag-ui/v1/run' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const sink = {
        writeEvent: (ev: AgUiEventPayload) => {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        },
        close: () => {
          res.write('data: [DONE]\n\n');
          res.end();
        },
      };
      try {
        const coordinator = this.bridge.getCoordinator() || (await this.bridge.createSessionCoordinator(body.threadId, body.agentId));
        await handleAgUiRunRequest(body, coordinator, sink);
      } catch (err: any) {
        sink.writeEvent({
          event: 'RUN_ERROR',
          threadId: body.threadId || 'default',
          runId: body.runId || 'default',
          data: { error: err.message },
          timestamp: Date.now(),
        });
        sink.close();
      }
      return;
    }

    // API: GET /api/connectors (3rd-Party OAuth Connectors)
    if (pathname === '/api/connectors' && req.method === 'GET') {
      await this.bridge.connectorManager.ensureLoaded();
      const list = this.bridge.listConnectors();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    // API: GET /api/connectors/:id
    if (pathname.startsWith('/api/connectors/') && !pathname.includes('/', 17) && req.method === 'GET') {
      await this.bridge.connectorManager.ensureLoaded();
      const id = pathname.replace('/api/connectors/', '') as any;
      const conn = this.bridge.getConnector(id);
      if (!conn) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Connector not found: ${id}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(conn));
      return;
    }

    // API: POST /api/connectors/:id/connect
    if (pathname.startsWith('/api/connectors/') && pathname.endsWith('/connect') && req.method === 'POST') {
      const id = pathname.replace('/api/connectors/', '').replace('/connect', '') as any;
      const body = await this.readJsonBody(req);
      if (body.token) {
        const result = await this.bridge.configureConnectorToken(id, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (body.code) {
        const result = await this.bridge.completeOAuth(id, body.code, body.state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      const flow = await this.bridge.initiateOAuth(id, body.redirectUri);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(flow));
      return;
    }

    // API: POST /api/connectors/:id/callback
    if (pathname.startsWith('/api/connectors/') && pathname.endsWith('/callback') && req.method === 'POST') {
      const id = pathname.replace('/api/connectors/', '').replace('/callback', '') as any;
      const body = await this.readJsonBody(req);
      const result = await this.bridge.completeOAuth(id, body.code || 'mock_code', body.state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: POST /api/connectors/:id/disconnect
    if (pathname.startsWith('/api/connectors/') && pathname.endsWith('/disconnect') && req.method === 'POST') {
      const id = pathname.replace('/api/connectors/', '').replace('/disconnect', '') as any;
      const ok = await this.bridge.disconnectConnector(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok, id }));
      return;
    }

    // API: POST /api/connectors/:id/test
    if (pathname.startsWith('/api/connectors/') && pathname.endsWith('/test') && req.method === 'POST') {
      const id = pathname.replace('/api/connectors/', '').replace('/test', '') as any;
      const result = await this.bridge.testConnector(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: GET /api/gallery/templates (Community Agent Store & Template Gallery)
    if (pathname === '/api/gallery/templates' && req.method === 'GET') {
      const category = (url.searchParams.get('category') as any) || undefined;
      const query = url.searchParams.get('query') || undefined;
      const tag = url.searchParams.get('tag') || undefined;
      const templates = await this.bridge.listGalleryTemplates({ category, query, tag });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(templates));
      return;
    }

    // API: POST /api/gallery/templates/publish
    if (pathname === '/api/gallery/templates/publish' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      if (!body.id || !body.name || !body.systemPrompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: id, name, systemPrompt' }));
        return;
      }
      const item = await this.bridge.publishGalleryTemplate(body);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
      return;
    }

    // API: POST /api/gallery/templates/:id/install
    if (pathname.startsWith('/api/gallery/templates/') && pathname.endsWith('/install') && req.method === 'POST') {
      const id = pathname.replace('/api/gallery/templates/', '').replace('/install', '');
      try {
        const result = await this.bridge.installGalleryTemplate(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: GET /api/gallery/templates/:id
    if (pathname.startsWith('/api/gallery/templates/') && req.method === 'GET') {
      const id = pathname.replace('/api/gallery/templates/', '');
      const tpl = this.bridge.getGalleryTemplate(id);
      if (!tpl) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Template not found: ${id}` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tpl));
      return;
    }

    // API: DELETE /api/gallery/templates/:id
    if (pathname.startsWith('/api/gallery/templates/') && req.method === 'DELETE') {
      const id = pathname.replace('/api/gallery/templates/', '');
      const deleted = await this.bridge.deleteGalleryTemplate(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: deleted, id }));
      return;
    }

    // API 404s: Any unmatched /api/* or /aiserver.* or /ag-ui/* route returns 404 JSON, never SPA index.html
    if (pathname.startsWith('/api/') || pathname.startsWith('/aiserver.') || pathname.startsWith('/ag-ui/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
      return;
    }

    // Serve static files from renderer/
    let filePath = path.join(this.rendererDir, pathname === '/' ? 'index.html' : pathname);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(this.rendererDir))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.join(this.rendererDir, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err: any) {
    if (!res.headersSent) {
      if (err.message && err.message.includes('exceeds size limit')) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else if (err.message && err.message.includes('Invalid JSON')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
      }
    }
  }
}

private async readJsonBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      let bytesRead = 0;
      let rejected = false;

      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        bytesRead += chunk.length;
        if (bytesRead > maxBytes) {
          rejected = true;
          req.destroy();
          reject(new Error('Request payload exceeds size limit (2MB)'));
          return;
        }
        data += chunk.toString('utf-8');
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', (err) => {
        if (!rejected) reject(err);
      });
    });
  }
}

// Standalone execution entry
if (process.argv[1] && process.argv[1].endsWith('desktop-server.js')) {
  const port = parseInt(process.env.PORT || '3456', 10);
  const server = new DesktopServer({ port });
  server.start().then(({ url }) => {
    console.log(`\n🚀 OpenSand Desktop UI running at: ${url}`);
    console.log(`   Open in your browser, or connect via native webview.\n`);
  });
}
