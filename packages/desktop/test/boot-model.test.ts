import test from "node:test";
import assert from "node:assert";
import {
  ACTIVE_AGENT_KEY,
  BOOT_PHASES,
  SESSION_KEY,
  bootStatus,
  needsAuthProbe,
  resolveActiveAgent,
  resolveSessionRestore,
} from "../src/shell/boot-model.js";

test("boot-model: auth probe only in the browser without a token", () => {
  assert.strictEqual(needsAuthProbe(false, null), true);
  assert.strictEqual(needsAuthProbe(false, ""), true);
  assert.strictEqual(needsAuthProbe(false, "token"), false);
  assert.strictEqual(needsAuthProbe(true, null), false);
});

test("boot-model: persisted agent is validated against the live roster", () => {
  const live = [{ id: "a-1", name: "Assistant" }];
  assert.deepStrictEqual(resolveActiveAgent(null, live), { agent: null, clearPersisted: false });
  assert.deepStrictEqual(resolveActiveAgent("a-1", live), { agent: live[0], clearPersisted: false });
  assert.deepStrictEqual(resolveActiveAgent("gone", live), { agent: null, clearPersisted: true });
});

test("boot-model: persisted session is validated against live sessions", () => {
  assert.deepStrictEqual(resolveSessionRestore(null, [{ id: "s-1" }]), { sessionId: null, clearPersisted: false });
  assert.deepStrictEqual(resolveSessionRestore("s-1", [{ id: "s-1" }]), { sessionId: "s-1", clearPersisted: false });
  assert.deepStrictEqual(resolveSessionRestore("gone", [{ id: "s-1" }]), { sessionId: null, clearPersisted: true });
});

test("boot-model: status and phase order", () => {
  assert.strictEqual(bootStatus(true, false), "loading");
  assert.strictEqual(bootStatus(false, true), "error");
  assert.strictEqual(bootStatus(false, false), "ready");
  assert.deepStrictEqual([...BOOT_PHASES], ["auth", "agents", "sessions", "restore", "ready"]);
  assert.strictEqual(ACTIVE_AGENT_KEY, "opensand-active-agent");
  assert.strictEqual(SESSION_KEY, "opensand-session-id");
});
