import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrantsStore } from "@opensand/shared";
import { LocalExecDaemon } from "../src/daemon.js";
import { migrateLegacyAllowlist } from "../src/legacy-allowlist-migration.js";

describe("legacy standing-allowlist.json migration", () => {
  let base: string;
  let stateDir: string;
  let legacy: string;
  let store: GrantsStore;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-legacy-migration-"));
    stateDir = path.join(base, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    legacy = path.join(stateDir, "standing-allowlist.json");
    store = new GrantsStore({ baseDir: base });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const writeLegacy = (allowlist: unknown) => fs.writeFileSync(legacy, JSON.stringify({ allowlist }));
  const aside = (marker: string) => fs.readdirSync(stateDir).filter((f) => f.startsWith(`standing-allowlist.json.${marker}-`));
  const scopes = async () => (await store.read()).grants.map((g) => `${g.tool}|${g.scope}|${g.lifetime}`).sort();

  it("imports legacy patterns as always exec grants, renames the file aside and never deletes it", async () => {
    writeLegacy(["git", "ls *", "bash -c x", "bash", "rm *", "a; b", ""]);
    const res = await migrateLegacyAllowlist(store, stateDir);
    assert.equal(res.status, "migrated");
    assert.deepEqual(await scopes(), ["exec_command|bash -c x|always", "exec_command|git *|always", "exec_command|ls *|always"]);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(aside("migrated").length, 1);
    assert.equal((await store.read()).epoch, 1, "importing adds authority and must not bump the epoch");
  });

  it("is idempotent: a second run adds nothing", async () => {
    writeLegacy(["git", "ls *"]);
    await migrateLegacyAllowlist(store, stateDir);
    const before = await scopes();
    assert.deepEqual(await migrateLegacyAllowlist(store, stateDir), { status: "none" });
    writeLegacy(["git", "ls *"]);
    await migrateLegacyAllowlist(store, stateDir);
    assert.deepEqual(await scopes(), before);
  });

  it("is a no-op without a legacy file", async () => {
    assert.deepEqual(await migrateLegacyAllowlist(store, stateDir), { status: "none" });
    assert.equal(fs.existsSync(store.filePath), false);
  });

  it("moves a corrupt legacy file aside as .corrupt-* and imports nothing", async () => {
    for (const bytes of ["{", JSON.stringify({ allowlist: "git" }), JSON.stringify(["git"]), "null"]) {
      fs.writeFileSync(legacy, bytes);
      assert.equal((await migrateLegacyAllowlist(store, stateDir)).status, "corrupt", bytes);
      assert.equal(fs.existsSync(legacy), false);
    }
    assert.equal(aside("corrupt").length, 4);
    assert.deepEqual(await scopes(), []);
  });

  it("crash after the import but before the rename: the rerun adds 0 and finishes the rename", async () => {
    writeLegacy(["git", "ls *"]);
    await assert.rejects(
      migrateLegacyAllowlist(store, stateDir, { afterImport: () => { throw new Error("simulated crash"); } }),
      /simulated crash/,
    );
    assert.equal(fs.existsSync(legacy), true, "legacy file is kept when the migration dies");
    const imported = await scopes();
    assert.equal(imported.length, 2);
    assert.equal((await migrateLegacyAllowlist(store, stateDir)).status, "migrated");
    assert.deepEqual(await scopes(), imported);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(aside("migrated").length, 1);
  });

  it("a crashed import (before anything was written) grants nothing and keeps the file", async () => {
    writeLegacy(["git"]);
    fs.writeFileSync(store.filePath, "{");
    await assert.rejects(migrateLegacyAllowlist(store, stateDir));
    assert.equal(fs.existsSync(legacy), true);
    assert.equal(fs.readFileSync(store.filePath, "utf8"), "{");
  });

  it("does not resurrect a revoked grant: after any revoke (epoch > 1) the legacy file is archived, not imported", async () => {
    const g = await store.addGrant({ tool: "exec_command", scope: "git *", lifetime: "always" });
    writeLegacy(["git"]);
    await store.revokeGrant(g.id);
    assert.equal((await migrateLegacyAllowlist(store, stateDir)).status, "archived");
    assert.deepEqual(await scopes(), []);
    assert.equal(aside("migrated").length, 1);
  });

  it("the daemon migrates lazily before its first gate read, so legacy 'always allow' keeps working", async () => {
    writeLegacy(["echo"]);
    const daemon = new LocalExecDaemon({ stateDir });
    const res = await daemon.executeTool("exec_command", { command: "echo legacy-ok" });
    assert.equal(res.status, "ok");
    assert.deepEqual(await scopes(), ["exec_command|echo *|always"]);
    assert.equal(fs.existsSync(legacy), false);
    // and the migrated grant is revocable
    const [g] = (await store.read()).grants;
    await store.revokeGrant(g.id);
    assert.equal((await daemon.executeTool("exec_command", { command: "echo legacy-ok" })).status, "permission_pending");
  });

  it("a migration failure never grants: the daemon denies and the legacy file stays put", async () => {
    writeLegacy(["echo"]);
    fs.writeFileSync(store.filePath, "{");
    const daemon = new LocalExecDaemon({ stateDir });
    assert.equal((await daemon.executeTool("exec_command", { command: "echo x" })).status, "permission_pending");
    assert.equal(fs.existsSync(legacy), true);
  });
});
