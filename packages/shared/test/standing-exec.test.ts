import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrantsStore } from "../src/grants-store.js";
import type { CapabilityGrant } from "../src/grants-types.js";
import { hasShellChaining, isStandingExecAllowed, legacyPatternsToGrants, standingExecPatterns } from "../src/standing-exec.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opensand-standing-"));
}

function grant(over: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return { id: "g1", tool: "exec_command", scope: "git *", lifetime: "always", epoch: 1, createdAt: 1, ...over };
}

test("hasShellChaining - flags ; & | backtick $( and newline, passes plain commands", () => {
  for (const bad of ["a; b", "a && b", "a | b", "a & b", "a `b`", "a $(b)", "a\nb"]) {
    assert.strictEqual(hasShellChaining(bad), true, bad);
  }
  for (const ok of ["git status", "ls -la /tmp", "echo 'hello world'"]) {
    assert.strictEqual(hasShellChaining(ok), false, ok);
  }
});

test("isStandingExecAllowed - an always exec_command prefix grant allows the bare binary and its arguments", () => {
  const grants = [grant()];
  assert.strictEqual(isStandingExecAllowed(grants, "git"), true);
  assert.strictEqual(isStandingExecAllowed(grants, "git status"), true);
  assert.strictEqual(isStandingExecAllowed(grants, "gitk"), false);
  assert.strictEqual(isStandingExecAllowed(grants, "rm -rf /"), false);
});

test("isStandingExecAllowed - chaining is rejected even when the prefix grant matches", () => {
  const grants = [grant()];
  for (const cmd of ["git status; rm -rf ~", "git status && id", "git log | sh", "git `id`", "git $(id)", "git status\nid"]) {
    assert.strictEqual(isStandingExecAllowed(grants, cmd), false, cmd);
  }
  // A wildcard grant does not bypass the guard either.
  assert.strictEqual(isStandingExecAllowed([grant({ scope: "*" })], "ls; id"), false);
});

test("isStandingExecAllowed - once, mission and folder grants are not standing", () => {
  for (const lifetime of ["once", "mission", "folder"] as const) {
    assert.strictEqual(isStandingExecAllowed([grant({ lifetime })], "git status"), false, lifetime);
  }
});

test("isStandingExecAllowed - expired always grants do not match, future and unset ones do", () => {
  const now = 1_000_000;
  assert.strictEqual(isStandingExecAllowed([grant({ expiresAt: now - 1 })], "git status", now), false);
  assert.strictEqual(isStandingExecAllowed([grant({ expiresAt: now })], "git status", now), false);
  assert.strictEqual(isStandingExecAllowed([grant({ expiresAt: now + 1 })], "git status", now), true);
  assert.strictEqual(isStandingExecAllowed([grant()], "git status", now), true);
});

test("isStandingExecAllowed - other tools and path/domain scopes never match a command", () => {
  assert.strictEqual(isStandingExecAllowed([grant({ tool: "read_file" })], "git status"), false);
  assert.strictEqual(isStandingExecAllowed([grant({ scope: "/tmp" })], "ls /tmp"), false);
  assert.strictEqual(isStandingExecAllowed([grant({ scope: "api.github.com" })], "ls"), false);
});

test("isStandingExecAllowed - exact-scope grant matches only that exact command", () => {
  const grants = [grant({ scope: "bash -c x" })];
  assert.strictEqual(isStandingExecAllowed(grants, "bash -c x"), true);
  assert.strictEqual(isStandingExecAllowed(grants, "bash -c y"), false);
  assert.strictEqual(isStandingExecAllowed(grants, "bash -c x extra"), false);
});

test("isStandingExecAllowed - corrupt or missing input denies", () => {
  assert.strictEqual(isStandingExecAllowed(undefined, "git status"), false);
  assert.strictEqual(isStandingExecAllowed(null as any, "git status"), false);
  assert.strictEqual(isStandingExecAllowed("nope" as any, "git status"), false);
  assert.strictEqual(isStandingExecAllowed({} as any, "git status"), false);
  assert.strictEqual(isStandingExecAllowed([grant()], undefined as any), false);
  assert.strictEqual(isStandingExecAllowed([grant()], "" as any), false);
  assert.strictEqual(isStandingExecAllowed([grant()], 42 as any), false);
  assert.strictEqual(isStandingExecAllowed([null, 7, "x", { tool: "exec_command" }] as any, "git status"), false);
  assert.strictEqual(isStandingExecAllowed([{ ...grant(), scope: undefined }] as any, "git status"), false);
});

test("standingExecPatterns - legacy view strips the trailing ' *', keeps exact scopes, ignores non-standing grants", () => {
  const view = standingExecPatterns([
    grant({ id: "a", scope: "git *" }),
    grant({ id: "b", scope: "bash -c x" }),
    grant({ id: "c", scope: "ls *", lifetime: "once" }),
    grant({ id: "d", scope: "npm *", expiresAt: 1 }),
    grant({ id: "e", scope: "/tmp" , tool: "read_file" }),
  ], 10);
  assert.deepStrictEqual(view, ["git", "bash -c x"]);
  assert.deepStrictEqual(standingExecPatterns(undefined), []);
});

test("legacyPatternsToGrants - converts single tokens to '<bin> *', keeps trailing-star and multi-token patterns", () => {
  const { grants, skipped } = legacyPatternsToGrants(["git", "ls *", "bash -c x"]);
  assert.deepStrictEqual(
    grants.map((g) => [g.tool, g.scope, g.lifetime]),
    [
      ["exec_command", "git *", "always"],
      ["exec_command", "ls *", "always"],
      ["exec_command", "bash -c x", "always"],
    ],
  );
  assert.deepStrictEqual(skipped, []);
});

test("legacyPatternsToGrants - skips dangerous interpreters alone, empty, wildcard-only, chaining and non-strings", () => {
  const dangerous = ["sh", "bash", "zsh", "node", "python", "python3", "perl", "ruby", "sudo", "su", "rm", "mv", "chmod", "chown", "curl", "wget", "cat", "dd"];
  const input = [...dangerous, ...dangerous.map((d) => `${d} *`), "bash -c *", "sudo rm *", "", "  ", "*", " * ", "git; rm", "ls | sh", "a $(b)", 5, null, { x: 1 }];
  const { grants, skipped } = legacyPatternsToGrants(input as any);
  assert.deepStrictEqual(grants, []);
  assert.strictEqual(skipped.length, input.length);
  assert.ok(skipped.every((s) => typeof s.reason === "string" && s.reason.length > 0));
});

test("legacyPatternsToGrants - non-array input yields nothing", () => {
  assert.deepStrictEqual(legacyPatternsToGrants({} as any), { grants: [], skipped: [] });
  assert.deepStrictEqual(legacyPatternsToGrants(undefined as any), { grants: [], skipped: [] });
});

test("legacyPatternsToGrants - dedupes by scope within the input (git and 'git *' are one grant)", () => {
  const { grants } = legacyPatternsToGrants(["git", "git *", " git "]);
  assert.deepStrictEqual(grants.map((g) => g.scope), ["git *"]);
});

test("importGrants - adds grants without bumping the epoch, stamped with the current epoch", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    const { grants } = legacyPatternsToGrants(["git", "ls *", "bash -c x"]);
    const res = await store.importGrants(grants);
    assert.strictEqual(res.added.length, 3);
    assert.strictEqual(res.skippedExisting, 0);
    const content = await store.read();
    assert.strictEqual(content.epoch, 1);
    assert.strictEqual(content.grants.length, 3);
    assert.ok(content.grants.every((g) => g.epoch === 1));
    assert.strictEqual(isStandingExecAllowed(content.grants, "git status"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importGrants - is idempotent: a second run adds nothing and leaves the file bytes alone", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    const { grants } = legacyPatternsToGrants(["git", "ls *", "bash -c x"]);
    await store.importGrants(grants);
    const before = fs.readFileSync(store.filePath, "utf8");
    const again = await store.importGrants(grants);
    assert.strictEqual(again.added.length, 0);
    assert.strictEqual(again.skippedExisting, 3);
    assert.strictEqual(fs.readFileSync(store.filePath, "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importGrants - dedupes by tool+scope+lifetime against existing grants and within the batch", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    await store.addGrant({ tool: "exec_command", scope: "git *", lifetime: "always" });
    await store.addGrant({ tool: "exec_command", scope: "ls *", lifetime: "once" });
    const res = await store.importGrants([
      { tool: "exec_command", scope: "git *", lifetime: "always" },
      { tool: "exec_command", scope: "ls *", lifetime: "always" }, // differs by lifetime from the once grant
      { tool: "exec_command", scope: "ls *", lifetime: "always" }, // duplicate inside the batch
      { tool: "read_file", scope: "git *", lifetime: "always" }, // differs by tool
    ]);
    assert.strictEqual(res.added.length, 2);
    assert.strictEqual(res.skippedExisting, 2);
    assert.strictEqual((await store.read()).grants.length, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importGrants - never bumps an epoch that revokes already raised", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    const g = await store.addGrant({ tool: "exec_command", scope: "x *", lifetime: "always" });
    await store.revokeGrant(g.id);
    const res = await store.importGrants([{ tool: "exec_command", scope: "git *", lifetime: "always" }]);
    assert.strictEqual((await store.read()).epoch, 2);
    assert.strictEqual(res.added[0].epoch, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importGrants - a corrupt grants.json is not repaired or overwritten", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    fs.writeFileSync(store.filePath, "{");
    await assert.rejects(() => store.importGrants([{ tool: "exec_command", scope: "git *", lifetime: "always" }]));
    assert.strictEqual(fs.readFileSync(store.filePath, "utf8"), "{");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importGrants - an empty batch writes nothing, even without a grants file", async () => {
  const dir = tmp();
  try {
    const store = new GrantsStore({ baseDir: dir });
    const res = await store.importGrants([]);
    assert.deepStrictEqual(res, { added: [], skippedExisting: 0 });
    assert.strictEqual(fs.existsSync(store.filePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
