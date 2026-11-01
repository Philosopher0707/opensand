import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcBridge } from './ipc-bridge.js';
import type { DesktopEvent, ApprovalDecision, DesktopSettings } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DesktopServerOptions {
  port?: number;
  host?: string;
  baseDir?: string;
}

export class DesktopServer {
  private server: http.Server | null = null;
  private bridge: DesktopIpcBridge;
  private sseClients: Set<http.ServerResponse> = new Set();
  private rendererDir: string;
  private port: number;
  private host: string;

  constructor(options: DesktopServerOptions = {}) {
    this.port = options.port || 3456;
    this.host = options.host || '127.0.0.1';
    this.bridge = new DesktopIpcBridge({ baseDir: options.baseDir });
    this.rendererDir = path.join(__dirname, '../../renderer');

    // Forward bridge events to SSE clients
    this.bridge.on('event', (event: DesktopEvent) => {
      this.broadcastSse(event);
    });
  }

  public getBridge(): DesktopIpcBridge {
    return this.bridge;
  }

  public async start(): Promise<{ port: number; host: string; url: string }> {
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
        const url = `http://${this.host}:${actualPort}`;
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

    // Host header validation to prevent DNS rebinding
    if (hostHeader) {
      const hostname = hostHeader.split(':')[0];
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access forbidden: invalid Host header' }));
        return;
      }
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const isValidId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

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

    // API: POST /api/query
    if (pathname === '/api/query' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const result = await this.bridge.sendQuery(body.query, body.sessionId, body.agentId);
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

    // API: GET /api/sessions
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const sessions = await this.bridge.getSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // API: GET /api/sessions/:id
    if (pathname.startsWith('/api/sessions/') && req.method === 'GET') {
      const sessionId = pathname.replace('/api/sessions/', '');
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

    // API: GET /api/settings
    if (pathname === '/api/settings' && req.method === 'GET') {
      const settings = this.bridge.getSettings();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settings));
      return;
    }

    // API: POST /api/settings
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const updated = this.bridge.updateSettings(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
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
