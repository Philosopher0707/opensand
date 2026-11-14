import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrantsStore } from "@opensand/shared";
import { LocalExecDaemon } from "../src/daemon.js";

// The daemon decides standing exec permission from <base>/grants.json (state dir = <base>/state).
// Each test uses its own base dir and its own try/finally-style cleanup, no shared teardown helper.
describe("standing exec permission comes from grants.json", () => {
  let base: string;
  let store: GrantsStore;
  let daemon: LocalExecDaemon;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-standing-grants-"));
    store = new GrantsStore({ baseDir: base });
    daemon = new LocalExecDaemon({ stateDir: path.join(base, "state") });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const run = (command: string) => daemon.executeTool("exec_command", { command });

  it("runs a command allowed by an always grant added to grants.json only (no legacy file)", async () => {
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    const res = await run("echo from-grants");
    assert.equal(res.status, "ok");
    assert.equal(res.output.stdout.trim(), "from-grants");
  });

  it("denies a command no grant covers", async () => {
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    assert.equal((await run("printf nope")).status, "permission_pending");
  });

  it("never lets a prefix grant cover shell chaining", async () => {
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    const marker = path.join(base, "chained");
    for (const cmd of [`echo hi; touch ${marker}`, `echo hi && touch ${marker}`, `echo $(touch ${marker})`, "echo hi | cat"]) {
      assert.equal((await run(cmd)).status, "permission_pending", cmd);
    }
    assert.equal(fs.existsSync(marker), false);
  });

  it("does not treat once, mission, folder or expired grants as standing", async () => {
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "once" });
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "mission", missionId: "m1" } as any);
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always", expiresAt: Date.now() - 1000 });
    assert.equal((await run("echo no")).status, "permission_pending");
  });

  it("does not let a path-scoped grant allow a command", async () => {
    await store.addGrant({ tool: "read_file", scope: "/tmp", lifetime: "always" });
    await store.addGrant({ tool: "exec_command", scope: "/tmp", lifetime: "always" });
    assert.equal((await run("ls /tmp")).status, "permission_pending");
  });

  it("denies and leaves the bytes alone when grants.json is corrupt, wrong version or wrong shape", async () => {
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    for (const bytes of ["{", JSON.stringify({ version: 2, epoch: 1, grants: [] }), JSON.stringify({ version: 1, epoch: 1, grants: "x" })]) {
      fs.writeFileSync(store.filePath, bytes);
      const res = await run("echo corrupt");
      assert.equal(res.status, "permission_pending", bytes);
      assert.equal(fs.readFileSync(store.filePath, "utf8"), bytes, "daemon must not repair or overwrite grants.json");
      const gates = await daemon.getGates();
      assert.equal(gates.grantsError, true);
      assert.deepEqual(gates.standingGrants, []);
      assert.equal(gates.grantsEpoch, -1);
    }
  });

  it("denies when grants.json is unreadable (EISDIR stands in for EACCES/EIO)", async () => {
    fs.mkdirSync(store.filePath, { recursive: true });
    const res = await run("echo unreadable");
    assert.equal(res.status, "permission_pending");
    assert.equal((await daemon.getGates()).grantsError, true);
  });

  it("denies when grants.json is missing, without creating it", async () => {
    assert.equal((await run("echo missing")).status, "permission_pending");
    assert.equal(fs.existsSync(store.filePath), false);
    assert.equal((await daemon.getGates()).grantsError, undefined);
  });

  it("derives the legacy standingAllowlist view from grants and ignores writes to it", async () => {
    await store.addGrant({ tool: "exec_command", scope: "git *", lifetime: "always" });
    await store.addGrant({ tool: "exec_command", scope: "ls -la", lifetime: "always" });
    assert.deepEqual((await daemon.getGates()).standingAllowlist, ["git", "ls -la"]);
    await daemon.updateGates({ standingAllowlist: ["rm"] });
    assert.deepEqual((await daemon.getGates()).standingAllowlist, ["git", "ls -la"]);
    assert.equal(fs.existsSync(path.join(base, "state", "standing-allowlist.json")), false);
  });

  it("revoke-then-run: a revoked always grant stops working in the same daemon", async () => {
    const grant = await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    assert.equal((await run("echo before")).status, "ok");
    await store.revokeGrant(grant.id);
    assert.equal((await run("echo after")).status, "permission_pending");
  });

  it("re-checks the epoch when the caller passes a stale gate snapshot", async () => {
    const grant = await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    const snapshot = await daemon.getGates();
    assert.equal(snapshot.grantsEpoch, 1);
    await store.revokeGrant(grant.id);
    const res = await daemon.executeTool("exec_command", { command: "echo stale" }, { permissionGates: snapshot });
    assert.equal(res.status, "permission_pending");
  });

  it("denies a stale gate snapshot when grants.json has become unreadable since", async () => {
    await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
    const snapshot = await daemon.getGates();
    assert.equal(snapshot.grantsEpoch, 1);
    fs.writeFileSync(store.filePath, "{");
    const res = await daemon.executeTool("exec_command", { command: "echo stale-corrupt" }, { permissionGates: snapshot });
    assert.equal(res.status, "permission_pending");
  });
});
