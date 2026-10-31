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
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    // CORS headers for local access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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

    // API: POST /api/query
    if (pathname === '/api/query' && req.method === 'POST') {
      const body = await this.readJsonBody(req);
      const result = await this.bridge.sendQuery(body.query, body.sessionId);
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

    // Serve static files from renderer/
    let filePath = path.join(this.rendererDir, pathname === '/' ? 'index.html' : pathname);
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
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
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
