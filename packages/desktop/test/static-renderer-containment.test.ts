import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { DesktopServer } from '../src/desktop-server.js';
import { closeThenRemove } from './teardown.js';

// F7 regression: static renderer serving must resolve symlinks with realpathSync and
// contain them with path.relative, matching workspace-file-read.ts. A lexical
// startsWith(rendererDir) check lets symlinks (and sibling prefixes) escape the tree.

class MockIncomingMessage extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string>;
  public socket: any;
  constructor(method: string, url: string, headers: Record<string, string> = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: '127.0.0.1:3456', ...headers };
    this.socket = { remoteAddress: '127.0.0.1' };
  }
  public destroy(): this { this.emit('close'); return this as any; }
}
class MockServerResponse extends EventEmitter {
  public statusCode: number = 200;
  public headers: Record<string, string> = {};
  public body: string = '';
  public setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  public writeHead(code: number, headers?: Record<string, string>) {
    this.statusCode = code;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
  }
  // Returns true so fs.createReadStream(...).pipe(res) keeps flowing without 'drain'.
  public write(chunk: string | Buffer) { this.body += chunk.toString(); return true; }
  public end(chunk?: string | Buffer) {
    if (chunk) this.body += chunk.toString();
    this.emit('finish');
  }
}

describe('DesktopServer - static renderer symlink containment (F7)', () => {
  let tmpDir: string;
  let root: string;
  let rendererDir: string;
  let outsideDir: string;
  let server: DesktopServer;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-static-containment-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-static-root-'));
    rendererDir = path.join(root, 'renderer');
    outsideDir = path.join(root, 'outside');
    fs.mkdirSync(rendererDir);
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(rendererDir, 'index.html'), '<html>index</html>');
    fs.writeFileSync(path.join(rendererDir, 'app.js'), 'console.log(1);');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET');
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(rendererDir, 'leak.txt'));
    fs.symlinkSync(outsideDir, path.join(rendererDir, 'outdir'));
    fs.symlinkSync(path.join(rendererDir, 'app.js'), path.join(rendererDir, 'inside-link.js'));
    server = new DesktopServer({ baseDir: tmpDir });
    (server as any).rendererDir = rendererDir;
  });

  after(async () => {
    await closeThenRemove([server?.getBridge()], tmpDir, root);
  });

  async function get(pathname: string): Promise<{ status: number; body: string }> {
    const req = new MockIncomingMessage('GET', pathname);
    const res = new MockServerResponse();
    const finished = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no response finish for ${pathname}`)), 5000);
      t.unref();
      res.once('finish', () => { clearTimeout(t); resolve(); });
    });
    // Streamed bodies finish after handleRequest returns; wait for both.
    await Promise.all([(server as any).handleRequest(req, res), finished]);
    return { status: res.statusCode, body: res.body };
  }

  it('refuses a symlinked file that points outside rendererDir', async () => {
    const res = await get('/leak.txt');
    assert.strictEqual(res.status, 403);
    assert.ok(!res.body.includes('OUTSIDE-SECRET'));
  });

  it('refuses a symlinked directory that points outside rendererDir', async () => {
    const res = await get('/outdir/secret.txt');
    assert.strictEqual(res.status, 403);
    assert.ok(!res.body.includes('OUTSIDE-SECRET'));
  });

  it('refuses a sibling directory sharing the rendererDir prefix', async () => {
    const sibling = path.join(root, 'renderer-evil');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'evil.txt'), 'SIBLING-SECRET');
    fs.symlinkSync(path.join(sibling, 'evil.txt'), path.join(rendererDir, 'sibling.txt'));
    const res = await get('/sibling.txt');
    assert.strictEqual(res.status, 403);
    assert.ok(!res.body.includes('SIBLING-SECRET'));
  });

  it('refuses the SPA fallback when index.html itself is a symlink out of the tree', async () => {
    fs.unlinkSync(path.join(rendererDir, 'index.html'));
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(rendererDir, 'index.html'));
    try {
      const res = await get('/some/spa/route');
      assert.strictEqual(res.status, 403);
      assert.ok(!res.body.includes('OUTSIDE-SECRET'));
    } finally {
      fs.unlinkSync(path.join(rendererDir, 'index.html'));
      fs.writeFileSync(path.join(rendererDir, 'index.html'), '<html>index</html>');
    }
  });

  it('still serves regular files and symlinks that stay inside rendererDir', async () => {
    const app = await get('/app.js');
    assert.strictEqual(app.status, 200);
    assert.ok(app.body.includes('console.log(1);'));
    const link = await get('/inside-link.js');
    assert.strictEqual(link.status, 200);
    assert.ok(link.body.includes('console.log(1);'));
    const index = await get('/');
    assert.strictEqual(index.status, 200);
    assert.ok(index.body.includes('<html>index</html>'));
  });

  it('falls back to index.html for missing files (SPA routing preserved)', async () => {
    const res = await get('/no/such/file');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('<html>index</html>'));
  });

  it('returns 404 cleanly when rendererDir does not exist', async () => {
    const saved = (server as any).rendererDir;
    (server as any).rendererDir = path.join(root, 'missing-renderer');
    try {
      const res = await get('/');
      assert.strictEqual(res.status, 404);
    } finally {
      (server as any).rendererDir = saved;
    }
  });
});
