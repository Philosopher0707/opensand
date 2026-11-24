import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const preloadPath = fileURLToPath(new URL('../src/preload.cjs', import.meta.url));
const preloadSource = fs.readFileSync(preloadPath, 'utf8');

type ExposedApis = Map<string, any>;

function runPreload(electron: unknown, options: { requireError?: Error; window?: unknown } = {}): ExposedApis {
  const exposed: ExposedApis = new Map();
  const module = electron as any;
  const effectiveElectron = module?.contextBridge
    ? {
        ...module,
        contextBridge: {
          ...module.contextBridge,
          exposeInMainWorld: (name: string, api: unknown) => {
            exposed.set(name, api);
            module.contextBridge.exposeInMainWorld(name, api);
          },
        },
      }
    : module;
  runInNewContext(preloadSource, {
    require: (name: string) => {
      assert.strictEqual(name, 'electron');
      if (options.requireError) throw options.requireError;
      return effectiveElectron;
    },
    window: options.window,
    exports: {},
    console: { error: () => {} },
  }, { filename: preloadPath });
  return exposed;
}

function realElectron(exposeInMainWorld = (_name: string, _api: unknown) => {}) {
  const invocations: unknown[][] = [];
  return {
    contextBridge: { exposeInMainWorld },
    ipcRenderer: {
      sendSync: (channel: string) => {
        assert.strictEqual(channel, 'opensand:isAllowedOrigin');
        return true;
      },
      invoke: async (...args: unknown[]) => {
        invocations.push(args);
        return ['real-session'];
      },
      on: () => {},
      removeListener: () => {},
    },
    invocations,
  };
}

test('preload exposes only the real Electron IPC bridge and forwards calls to ipcRenderer', async () => {
  const electron = realElectron();
  const exposed = runPreload(electron);

  assert.deepStrictEqual([...exposed.keys()], ['api', 'opensand']);
  assert.deepStrictEqual(await exposed.get('opensand').getSessions(), ['real-session']);
  assert.deepStrictEqual(electron.invocations, [['opensand:getSessions']]);
});

test('preload fails loudly instead of installing a mock when Electron APIs cannot load', () => {
  assert.throws(
    () => runPreload(undefined, { requireError: new Error('electron unavailable') }),
    /Electron preload APIs could not be loaded/,
  );
});

test('preload fails closed when the renderer origin cannot be verified', () => {
  const electron = realElectron();
  electron.ipcRenderer.sendSync = () => { throw new Error('main process unavailable'); };

  assert.throws(
    () => runPreload(electron, { window: { location: { origin: 'http://localhost:3456' } } }),
    /could not verify the renderer origin/i,
  );
});

test('preload never falls back to a localhost regex when the main process denies the origin', () => {
  const electron = realElectron();
  electron.ipcRenderer.sendSync = () => false;

  assert.throws(
    () => runPreload(electron, { window: { location: { origin: 'http://localhost:3456' } } }),
    /refusing to expose the OpenSand bridge/i,
  );
});

test('preload propagates bridge exposure failures instead of running partially mocked', () => {
  const electron = realElectron(() => { throw new Error('bridge frozen'); });

  assert.throws(
    () => runPreload(electron),
    /failed to expose the OpenSand desktop bridge/i,
  );
});
