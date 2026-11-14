import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventLogLock } from "../src/event-log-lock.js";
import { GrantsStore, StaleEpochError, isToolExecutionGranted } from "../src/grants-store.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opensand-grants-"));
}

test("GrantsStore - fresh store is epoch 1; addGrant keeps it, revokeGrant bumps by exactly one", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    assert.strictEqual((await store.read()).epoch, 1);
    const a = await store.addGrant({ tool: "exec_command", scope: "git *", lifetime: "always" });
    await store.addGrant({ tool: "read_file", scope: "/repo", lifetime: "folder", folderPath: "/repo" });
    const afterAdd = await store.read();
    assert.strictEqual(afterAdd.epoch, 1);
    assert.strictEqual(afterAdd.grants.length, 2);
    assert.deepStrictEqual(await store.revokeGrant(a.id), { revoked: true, epoch: 2 });
    assert.strictEqual((await store.read()).epoch, 2);
    assert.deepStrictEqual(await store.revokeGrant("nope"), { revoked: false, epoch: 2 });
    assert.strictEqual(fs.statSync(store.filePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GrantsStore - checkEpoch fails closed with StaleEpochError 4001", () => {
  GrantsStore.checkEpoch(1, 1);
  for (const bad of [undefined, 0, 2, "1"]) {
    assert.throws(() => GrantsStore.checkEpoch(bad, 1), (err: any) => err instanceof StaleEpochError && err.code === 4001);
  }
});

test("GrantsStore - 10 real processes add distinct grants concurrently without loss or leftovers", async () => {
  const dir = tmp();
  try {
    const worker = fileURLToPath(new URL("./fixtures/grant-writer-worker.js", import.meta.url));
    const codes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        new Promise<number | null>((resolve, reject) => {
          const child = fork(worker, [dir, String(i)], { stdio: "inherit" });
          child.once("error", reject);
          child.once("exit", resolve);
        }),
      ),
    );
    assert.deepStrictEqual(codes, Array(10).fill(0));
    const content = JSON.parse(fs.readFileSync(path.join(dir, "grants.json"), "utf8"));
    assert.strictEqual(content.grants.length, 10);
    assert.deepStrictEqual(
      content.grants.map((g: any) => g.id).sort(),
      Array.from({ length: 10 }, (_, i) => `worker-${i}`).sort(),
    );
    assert.strictEqual(content.epoch, 1);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f === "grants.lock");
    assert.deepStrictEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isToolExecutionGranted - scoped matching", () => {
  const base = { epoch: 1, createdAt: 0, lifetime: "always" as const };
  const grants = [
    { ...base, id: "1", tool: "exec_command", scope: "git *" },
    { ...base, id: "2", tool: "read_file", scope: "/repo" },
    { ...base, id: "3", tool: "web_fetch", scope: "api.github.com" },
    { ...base, id: "4", tool: "exec_command", scope: "ls *", expiresAt: 100 },
  ];
  assert.ok(isToolExecutionGranted(grants, { tool: "exec_command", command: "git status", cwd: "/repo" }));
  assert.ok(!isToolExecutionGranted(grants, { tool: "exec_command", command: "gitk", cwd: "/repo" }));
  assert.ok(!isToolExecutionGranted(grants, { tool: "exec_command", command: "rm -rf /", cwd: "/repo" }));
  assert.ok(isToolExecutionGranted(grants, { tool: "read_file", path: "/repo/src/a.ts" }));
  assert.ok(!isToolExecutionGranted(grants, { tool: "read_file", path: "/repo2/a.ts" }));
  assert.ok(isToolExecutionGranted(grants, { tool: "web_fetch", domain: "api.github.com" }));
  assert.ok(!isToolExecutionGranted(grants, { tool: "web_fetch", domain: "evil.com" }));
  assert.ok(!isToolExecutionGranted(grants, { tool: "exec_command", command: "ls -la" }, 200), "expired grant");
});

test("GrantsStore.withEpoch - fails closed on missing/stale epoch and never runs fn", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    for (const bad of [undefined, 0, 2, "1"]) {
      let ran = false;
      await assert.rejects(
        store.withEpoch(bad, () => { ran = true; }),
        (err: any) => err instanceof StaleEpochError && err.code === 4001,
      );
      assert.strictEqual(ran, false);
    }
    // Check-only fn: nothing persisted. Mutating fn: persisted.
    await store.withEpoch(1, () => "check only");
    assert.strictEqual(fs.existsSync(store.filePath), false, "a check-only call must not write the file");
    await store.withEpoch(1, (c) => { c.grants.push(GrantsStore.newGrant({ tool: "exec_command", scope: "git *", lifetime: "always" }, c)); });
    assert.strictEqual((await store.read()).grants.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GrantsStore.withEpoch - a revoke landing while withEpoch waits for the lock is caught (check is under the lock)", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    const seed = await store.addGrant({ tool: "exec_command", scope: "ls *", lifetime: "always" });
    // Hold grants.lock so withEpoch queues; the revoke "lands" meanwhile (edited under the lock).
    const lock = await EventLogLock.acquire(dir, { timeoutMs: 5000, lockFileName: "grants.lock" });
    let ran = false;
    const outcome = store
      .withEpoch(1, (c) => {
        ran = true;
        c.grants.push(GrantsStore.newGrant({ tool: "exec_command", scope: "evil *", lifetime: "always" }, c));
      })
      .then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 100));
    const content = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    content.grants = content.grants.filter((g: any) => g.id !== seed.id);
    content.epoch = 2;
    fs.writeFileSync(store.filePath, JSON.stringify(content));
    await lock.release();
    const err = await outcome;
    assert.ok(err instanceof StaleEpochError && err.code === 4001, "withEpoch must throw 4001");
    assert.strictEqual(ran, false, "fn must not run at a stale epoch");
    const after = await store.read();
    assert.strictEqual(after.epoch, 2);
    assert.deepStrictEqual(after.grants, [], "no grant may be written at a stale epoch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GrantsStore.withEpoch - a revoke from another process waits until fn has finished", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    const seed = await store.addGrant({ tool: "exec_command", scope: "ls *", lifetime: "always" });
    const worker = fileURLToPath(new URL("./fixtures/revoke-worker.js", import.meta.url));
    const done = path.join(dir, "revoke.done");
    let exited!: Promise<number | null>;
    let doneDuringFn = true;
    await store.withEpoch(1, async (c) => {
      // fork from inside fn, i.e. while grants.lock is held
      exited = new Promise((resolve, reject) => {
        const child = fork(worker, [dir, seed.id, done], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", resolve);
      });
      await new Promise((r) => setTimeout(r, 1500)); // ample time for the child to boot and try the lock
      doneDuringFn = fs.existsSync(done);
      c.grants.push(GrantsStore.newGrant({ tool: "exec_command", scope: "git *", lifetime: "always" }, c));
    });
    assert.strictEqual(doneDuringFn, false, "revoke must not complete while withEpoch holds the lock");
    assert.strictEqual(await exited, 0);
    const final = await store.read();
    assert.strictEqual(final.epoch, 2, "the revoke ran after fn");
    assert.ok(!final.grants.some((g) => g.id === seed.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
