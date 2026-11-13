import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
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

test("GrantsStore - assertEpoch fails closed with StaleEpochError 4001", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    assert.strictEqual(await store.assertEpoch(1), 1);
    for (const bad of [undefined, 0, 2, "1"]) {
      await assert.rejects(store.assertEpoch(bad), (err: any) => err instanceof StaleEpochError && err.code === 4001);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
