import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The fallback is a classic browser script copied verbatim by Vite; exercise it
// with a tiny DOM stub so a broken bootstrap cannot leave a blank window.
const scriptPath = fileURLToPath(new URL('../../renderer-next/public/boot-fallback.js', import.meta.url));
const SOURCE = fs.readFileSync(path.resolve(scriptPath), 'utf8');

function boot(withMountedApp: boolean): { body: { appendChild: (node: unknown) => void }; fire: (type: string) => void; tick: () => void; appended: () => Array<{ id: string; textContent: string }> } {
  const nodes: Array<{ id: string; textContent: string; setAttribute: () => void; style: { cssText: string } }> = [];
  const body = { appendChild: (node: unknown) => { nodes.push(node as typeof nodes[number]); } };
  const root = { firstElementChild: withMountedApp ? {} : null };
  const listeners = new Map<string, (() => void)[]>();
  let timer: (() => void) | null = null;
  const context = {
    document: {
      body,
      getElementById: (id: string) => (id === 'root' ? root : null),
      createElement: () => ({ id: '', textContent: '', setAttribute: () => {}, style: { cssText: '' } }),
    },
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    setTimeout: (fn: () => void) => { timer = fn; },
  };
  vm.runInNewContext(SOURCE, context);
  return {
    body,
    fire: (type: string) => { for (const fn of listeners.get(type) ?? []) fn(); },
    tick: () => { timer?.(); },
    appended: () => nodes,
  };
}

test('boot failure shows a visible plain message instead of a blank window', () => {
  const page = boot(false);
  page.fire('error');
  assert.strictEqual(page.appended().length, 1, 'an error must show the message immediately');
  assert.match(page.appended()[0].textContent, /could not start the new interface.*OPENSAND_RENDERER=legacy/);
  page.fire('error'); // repeated errors must not stack messages
  assert.strictEqual(page.appended().length, 1);
});

test('boot fallback stays silent when the Preact app mounted', () => {
  const page = boot(true);
  page.fire('error');
  page.tick();
  assert.strictEqual(page.appended().length, 0);
});

test('a module that never mounts shows the message on the timeout', () => {
  const page = boot(false);
  page.tick();
  assert.strictEqual(page.appended().length, 1);
});
