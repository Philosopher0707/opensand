import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FolderTrustStore } from "../src/folder-trust-store.js";
import { GrantsStore, StaleEpochError } from "../src/grants-store.js";

function tmp(prefix = "opensand-trust-"): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

async function withDirs(fn: (base: string, root: string, store: FolderTrustStore) => Promise<void>): Promise<void> {
  const base = tmp();
  const root = tmp("opensand-trust-folders-");
  try {
    await fn(base, root, new FolderTrustStore({ baseDir: base }));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function mkdir(root: string, name: string): string {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

test("FolderTrustStore - absent, corrupt, wrong-version and unknown-level files all read as prompt", async () => {
  await withDirs(async (base, root, store) => {
    const f = mkdir(root, "f");
    assert.strictEqual(await store.getLevel(f), "prompt");
    fs.writeFileSync(store.filePath, "{not json");
    assert.strictEqual(await store.getLevel(f), "prompt");
    assert.strictEqual(store.getLevelSync(f), "prompt");
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 2, folders: { [f]: { level: "trusted" } } }));
    assert.strictEqual(await store.getLevel(f), "prompt");
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, folders: { [f]: { level: "root" } } }));
    assert.strictEqual(await store.getLevel(f), "prompt");
    fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, folders: { [f]: { level: "trusted" } } }));
    assert.strictEqual(await store.getLevel(f), "trusted");
  });
});

test("FolderTrustStore - round trip, mode 0600, key is the realpath", async () => {
  await withDirs(async (base, root, store) => {
    const v = mkdir(root, "v");
    const s = path.join(root, "s");
    fs.symlinkSync(v, s);
    await store.setLevel(s, "trusted");
    assert.strictEqual(fs.statSync(store.filePath).mode & 0o777, 0o600);
    const content = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    assert.deepStrictEqual(Object.keys(content.folders), [fs.realpathSync.native(v)]);
    assert.strictEqual(await store.getLevel(v), "trusted");
    assert.strictEqual(store.getLevelSync(v), "trusted");
  });
});

test("FolderTrustStore - symlinks and subfolders never inherit trust; missing folder throws", async () => {
  await withDirs(async (base, root, store) => {
    const t = mkdir(root, "T");
    const u = mkdir(root, "U");
    fs.symlinkSync(t, path.join(u, "inner"));
    await store.setLevel(t, "trusted");
    assert.strictEqual(await store.getLevel(u), "prompt");
    assert.strictEqual(await store.getLevel(path.join(u, "inner")), "trusted");
    const sub = mkdir(t, "sub");
    assert.strictEqual(await store.getLevel(sub), "prompt");
    await assert.rejects(store.getLevel(path.join(root, "missing")), /ENOENT/);
    await assert.rejects(store.setLevel(path.join(root, "missing"), "trusted"), /ENOENT/);
    assert.throws(() => FolderTrustStore.canonicalFolder(path.join(root, "missing")));
  });
});

test("FolderTrustStore - lowering bumps the epoch by exactly one; raising and same level do not", async () => {
  await withDirs(async (base, root, store) => {
    const f = mkdir(root, "f");
    const g = mkdir(root, "g");
    const epoch = () => new GrantsStore({ baseDir: base }).readSync().epoch;
    assert.strictEqual(epoch(), 1);
    assert.deepStrictEqual(await store.setLevel(f, "trusted"), { changed: true, narrowed: false, epoch: 1 });
    assert.strictEqual(epoch(), 1);
    assert.deepStrictEqual(await store.setLevel(f, "untrusted"), { changed: true, narrowed: true, epoch: 2 });
    assert.strictEqual(epoch(), 2);
    assert.strictEqual((await store.setLevel(f, "trusted")).narrowed, false);
    assert.strictEqual(epoch(), 2);
    const r = await store.setLevel(f, "prompt");
    assert.deepStrictEqual([r.narrowed, r.epoch], [true, 3]);
    assert.strictEqual((await store.setLevel(f, "trusted")).epoch, 3);
    assert.strictEqual((await store.setLevel(f, "prompt")).epoch, 4);
    assert.strictEqual((await store.setLevel(f, "untrusted")).epoch, 5);
    // prompt -> untrusted for a folder with no record is also a lowering
    assert.strictEqual((await store.setLevel(g, "untrusted")).epoch, 6);
    // same level: no bump, no rewrite
    const before = fs.statSync(store.filePath).mtimeMs;
    await new Promise((r2) => setTimeout(r2, 20));
    assert.deepStrictEqual(await store.setLevel(g, "untrusted"), { changed: false, narrowed: false, epoch: 6 });
    assert.strictEqual(fs.statSync(store.filePath).mtimeMs, before);
    assert.strictEqual(epoch(), 6);
  });
});

test("FolderTrustStore - 10 real processes lower different folders and add grants concurrently", async () => {
  await withDirs(async (base, root, store) => {
    const folders = Array.from({ length: 10 }, (_, i) => mkdir(root, `f${i}`));
    for (const f of folders) await store.setLevel(f, "trusted");
    const worker = fileURLToPath(new URL("./fixtures/trust-writer-worker.js", import.meta.url));
    const codes = await Promise.all(
      folders.map(
        (f, i) =>
          new Promise<number | null>((resolve, reject) => {
            const child = fork(worker, [base, f, String(i)], { stdio: "inherit" });
            child.once("error", reject);
            child.once("exit", resolve);
          }),
      ),
    );
    assert.deepStrictEqual(codes, Array(10).fill(0));
    const trust = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    assert.strictEqual(Object.keys(trust.folders).length, 10);
    for (const f of folders) assert.strictEqual(trust.folders[f].level, "untrusted");
    const grants = JSON.parse(fs.readFileSync(path.join(base, "grants.json"), "utf8"));
    assert.strictEqual(grants.grants.length, 10);
    assert.strictEqual(grants.epoch, 1 + 10);
    const leftovers = fs.readdirSync(base).filter((n) => n.endsWith(".tmp") || n === "grants.lock");
    assert.deepStrictEqual(leftovers, []);
  });
});

test("GrantsStore.narrowAuthority - epoch is persisted before the side effect (crash leaves a spurious bump, trust unchanged)", async () => {
  await withDirs(async (base, root, store) => {
    const f = mkdir(root, "f");
    await store.setLevel(f, "trusted");
    const grants = new GrantsStore({ baseDir: base });
    await assert.rejects(
      grants.narrowAuthority(async () => {
        assert.strictEqual(grants.readSync().epoch, 2, "bumped epoch must already be on disk");
        throw new Error("crash");
      }),
      /crash/,
    );
    assert.strictEqual(grants.readSync().epoch, 2);
    assert.strictEqual(await store.getLevel(f), "trusted");
    assert.ok(!fs.existsSync(path.join(base, "grants.lock")));
  });
});

/**
 * Deterministic interleaving, no sleeps: `land` runs exactly once, at the moment the store is about to
 * take grants.lock (or, for the old lock-free assertEpoch, right after it returned). So a revoke lands
 * after the caller has read the epoch and before its write.
 */
function landBeforeLock(grants: GrantsStore, land: () => Promise<unknown>): void {
  let done = false;
  const once = async () => {
    if (done) return;
    done = true;
    await land();
  };
  const g = grants as any;
  for (const name of ["underLock", "narrowAuthority", "withEpoch"]) {
    const orig = g[name].bind(grants);
    g[name] = async (...args: unknown[]) => {
      await once();
      return orig(...args);
    };
  }
  if (typeof g.assertEpoch === "function") {
    const orig = g.assertEpoch.bind(grants);
    g.assertEpoch = async (...args: unknown[]) => {
      const r = await orig(...args);
      await once();
      return r;
    };
  }
}

for (const [name, seed, level] of [
  ["non-narrowing (prompt -> trusted)", undefined, "trusted"],
  ["narrowing (trusted -> untrusted)", "trusted", "untrusted"],
] as const) {
  test(`FolderTrustStore - setLevel requireEpoch, ${name}: a revoke landing before the write throws 4001 and writes nothing`, async () => {
    const base = tmp();
    const root = tmp("opensand-trust-folders-");
    try {
      const grants = new GrantsStore({ baseDir: base });
      const store = new FolderTrustStore({ baseDir: base, grants });
      const other = new GrantsStore({ baseDir: base });
      const f = mkdir(root, "f");
      if (seed) await store.setLevel(f, seed);
      const g = await other.addGrant({ tool: "exec_command", scope: "git *", lifetime: "always" });
      const epoch = (await grants.read()).epoch;
      const before = fs.existsSync(store.filePath) ? fs.readFileSync(store.filePath, "utf8") : null;
      landBeforeLock(grants, () => other.revokeGrant(g.id));
      await assert.rejects(
        store.setLevel(f, level, { requireEpoch: epoch }),
        (err: any) => err instanceof StaleEpochError && err.code === 4001 && err.currentEpoch === epoch + 1,
      );
      const after = fs.existsSync(store.filePath) ? fs.readFileSync(store.filePath, "utf8") : null;
      assert.strictEqual(after, before, "folder-trust.json unchanged");
      assert.strictEqual(await store.getLevel(f), seed ?? "prompt");
      assert.strictEqual((await grants.read()).epoch, epoch + 1, "a stale narrowing must not bump the epoch");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("FolderTrustStore - setLevel requireEpoch: matching epoch writes; missing epoch fails closed", async () => {
  await withDirs(async (base, root) => {
    const grants = new GrantsStore({ baseDir: base });
    const store = new FolderTrustStore({ baseDir: base, grants });
    const f = mkdir(root, "f");
    await assert.rejects(store.setLevel(f, "trusted", { requireEpoch: undefined }), (e: any) => e instanceof StaleEpochError);
    assert.strictEqual(await store.getLevel(f), "prompt");
    await store.setLevel(f, "trusted", { requireEpoch: (await grants.read()).epoch });
    assert.strictEqual(await store.getLevel(f), "trusted");
  });
});
