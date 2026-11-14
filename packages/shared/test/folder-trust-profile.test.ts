import test from "node:test";
import * as assert from "node:assert";
import { profileForTrust, resolveSandboxProfile } from "../src/folder-trust.js";
import type { CapabilityGrant } from "../src/grants-types.js";

const grant = (scope: string): CapabilityGrant => ({
  id: "g1",
  tool: "sandbox.full",
  scope,
  lifetime: "folder",
  epoch: 1,
  createdAt: 0,
});

test("profileForTrust - only trusted is writable; nothing yields full", () => {
  assert.strictEqual(profileForTrust("trusted"), "workspace-write");
  assert.strictEqual(profileForTrust("prompt"), "read-only");
  assert.strictEqual(profileForTrust("untrusted"), "read-only");
});

test("resolveSandboxProfile - full needs request, trusted level and a matching sandbox.full grant", () => {
  const folder = "/work/a";
  const r = (level: any, requested: any, grants: CapabilityGrant[]) =>
    resolveSandboxProfile({ level, requested, grants, folder });
  assert.strictEqual(r("trusted", "full", []), "workspace-write");
  assert.strictEqual(r("prompt", "full", [grant(folder)]), "read-only");
  assert.strictEqual(r("untrusted", "full", [grant(folder)]), "read-only");
  assert.strictEqual(r("trusted", "full", [grant("/work/other")]), "workspace-write");
  assert.strictEqual(r("trusted", "full", [grant(folder)]), "full");
  assert.strictEqual(r("trusted", undefined, [grant(folder)]), "workspace-write");
});
