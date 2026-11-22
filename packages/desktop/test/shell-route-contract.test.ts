import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Overridable so the mutation check can point the matcher at a patched copy of data.ts.
const DATA_FILE = process.env.SHELL_CONTRACT_DATA ?? path.join(pkgRoot, 'renderer-next/src/data.ts');
const SERVER_FILE = path.join(pkgRoot, 'src/desktop-server.ts');

interface HttpCall {
  method: string;
  path: string;
  line: number;
}

interface ServerRoute {
  method: string;
  path: string;
  line: number;
}

/**
 * `${expr}` is a path segment when it is glued between slashes; otherwise it is a
 * query fragment (e.g. `/api/tokens${qs}`). Drop query strings after normalising.
 */
export function normalisePath(raw: string): string {
  const withParams = raw.replace(/\$\{[^}]*\}/g, (match: string, offset: number, whole: string) => {
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    return before === '/' || after === '/' ? ':param' : '';
  });
  return withParams.split('?')[0];
}

export function collectShellCalls(src: string): HttpCall[] {
  const calls: HttpCall[] = [];
  const fetchCall = /fetch\(\s*(["`])([^"`]+)\1\s*(?:,\s*\{((?:[^{}]|\{[^{}]*\})*)\})?/g;
  let match: RegExpExecArray | null;
  while ((match = fetchCall.exec(src)) !== null) {
    const method = match[3]?.match(/method\s*:\s*["']([A-Z]+)["']/)?.[1] ?? 'GET';
    const line = src.slice(0, match.index).split('\n').length;
    calls.push({ method, path: normalisePath(match[2]), line });
  }
  return calls;
}

export function collectServerRoutes(src: string): ServerRoute[] {
  const routes: ServerRoute[] = [];
  src.split('\n').forEach((line, index) => {
    const method = line.match(/req\.method\s*===\s*["']([A-Z]+)["']/)?.[1];
    if (!method) return;
    const exact = line.match(/pathname\s*===\s*["']([^"']+)["']/)?.[1];
    const starts = line.match(/pathname\.startsWith\(\s*["']([^"']+)["']\s*\)/)?.[1];
    const ends = line.match(/pathname\.endsWith\(\s*["']([^"']+)["']\s*\)/)?.[1];
    let routePath: string | undefined;
    if (exact) {
      routePath = exact;
    } else if (starts) {
      const prefix = starts.endsWith('/') ? starts.slice(0, -1) : starts;
      routePath = `${prefix}/:param${ends ?? ''}`;
    }
    if (routePath) routes.push({ method, path: routePath, line: index + 1 });
  });
  return routes;
}

function pathMatches(callPath: string, routePath: string): boolean {
  const a = callPath.split('/');
  const b = routePath.split('/');
  return a.length === b.length && a.every((seg, i) => seg === ':param' || b[i] === ':param' || seg === b[i]);
}

export function findMismatches(calls: HttpCall[], routes: ServerRoute[]): string[] {
  return calls
    .filter((call) => !routes.some((route) => route.method === call.method && pathMatches(call.path, route.path)))
    .map((call) => `${call.method} ${call.path} (data.ts:${call.line})`);
}

test('every shell HTTP call matches a route registered by the real desktop server', () => {
  const calls = collectShellCalls(fs.readFileSync(DATA_FILE, 'utf8'));
  const routes = collectServerRoutes(fs.readFileSync(SERVER_FILE, 'utf8'));
  assert.ok(calls.length > 0, 'no fetch calls found in data.ts');
  assert.ok(routes.length > 0, 'no routes found in desktop-server.ts');
  const mismatches = findMismatches(calls, routes);
  assert.deepStrictEqual(mismatches, [], `Unmatched shell routes:\n${mismatches.join('\n')}`);
});

test('matcher accepts a known-good fixture pair', () => {
  const calls = collectShellCalls('await fetch("/api/routines", { method: "POST", body: JSON.stringify({ name: "x" }) });');
  const routes = collectServerRoutes("if (pathname === '/api/routines' && req.method === 'POST') { return; }");
  assert.deepStrictEqual(findMismatches(calls, routes), []);
});

test('matcher rejects a known-bad pair (POST vs PATCH) and an unregistered path', () => {
  const shell = 'await fetch(`/api/routines/${id}/enabled`, { method: "POST" });\n'
    + 'await fetch("/api/not-a-route");';
  const routes = collectServerRoutes(
    "if (pathname.startsWith('/api/routines/') && pathname.endsWith('/enabled') && req.method === 'PATCH') { return; }"
  );
  const mismatches = findMismatches(collectShellCalls(shell), routes);
  assert.strictEqual(mismatches.length, 2, `expected two mismatches, got: ${mismatches.join(', ')}`);
  assert.strictEqual(mismatches[0], 'POST /api/routines/:param/enabled (data.ts:1)');
  assert.strictEqual(mismatches[1], 'GET /api/not-a-route (data.ts:2)');
});
