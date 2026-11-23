import test from "node:test";
import * as assert from "node:assert/strict";
import {
  APPROVAL_MODES,
  APPROVAL_LABELS,
  EFFECTS,
  NEVER_AUTO,
  AUTO_EDIT,
  SHELLS,
  approvalModeOf,
  effectOf,
  autoAllows,
} from "../src/approval.js";
import { GrantsStore, isToolExecutionGranted } from "../src/grants-store.js";

test("approval modes, labels, and effect constants", () => {
  assert.deepEqual(APPROVAL_MODES, ["ask", "auto_edit", "auto"]);
  assert.equal(APPROVAL_LABELS.ask, "Ask every time");
  assert.equal(APPROVAL_LABELS.auto_edit, "Auto-edit");
  assert.equal(APPROVAL_LABELS.auto, "Auto-approve");
  assert.ok(EFFECTS.read && EFFECTS.edit && EFFECTS.shell && EFFECTS.shell_outside);
  assert.ok(NEVER_AUTO.has("control") && NEVER_AUTO.has("spend") && NEVER_AUTO.has("self"));
  assert.ok(AUTO_EDIT.has("read") && AUTO_EDIT.has("edit") && AUTO_EDIT.has("shell") && AUTO_EDIT.has("delegate"));
  assert.ok(SHELLS.has("shell") && SHELLS.has("shell_outside"));
});

test("approvalModeOf resolves mode with session priority and default fallback", () => {
  assert.equal(approvalModeOf(null, {}), "ask");
  assert.equal(approvalModeOf(undefined, {}), "ask");
  assert.equal(approvalModeOf({ approvalMode: "auto" }, { approvalMode: "ask" }), "auto");
  assert.equal(approvalModeOf(null, { approvalMode: "auto_edit" }), "auto_edit");
  assert.equal(approvalModeOf({ approvalMode: "auto_edit" }, { approvalMode: "auto" }), "auto_edit");
  assert.equal(approvalModeOf({ approvalMode: "invalid" as any }, { approvalMode: "ask" }), "ask");
  // autoApprove backward-compatibility fallback
  assert.equal(approvalModeOf(null, { autoApprove: true }), "auto");
});

test("effectOf resolves declared effects and defaults", () => {
  assert.equal(effectOf({ effect: "read" }), "read");
  assert.equal(effectOf({ effect: "edit" }), "edit");
  assert.equal(effectOf({ effect: "shell" }), "shell");
  assert.equal(
    effectOf({ effect: (args: any) => (args.unsandboxed ? "shell_outside" : "shell") }, { unsandboxed: true }),
    "shell_outside",
  );
  assert.equal(
    effectOf({ effect: (args: any) => (args.unsandboxed ? "shell_outside" : "shell") }, { unsandboxed: false }),
    "shell",
  );
  assert.equal(effectOf({ access: "read" }), "read");
  assert.equal(effectOf({ access: "write" }), "unknown");
  assert.equal(effectOf(null), "unknown");
  assert.equal(effectOf({ effect: "not_a_real_effect" }), "unknown");
});

test("autoAllows: what each mode lets through without asking; unknown fails closed", () => {
  const req = (name: string, effect: string, extra = {}) => ({ name, effect, ...extra });

  const writeReq = req("write_file", "edit");
  const editReq = req("edit_file", "edit");
  const readReq = req("read_file", "read");
  const shellReq = req("exec_command", "shell");
  const shellOutsideReq = req("exec_command", "shell_outside");
  const delegateReq = req("delegate_to_agent", "delegate");
  const netReq = req("web_fetch", "network");
  const browserReq = req("browser_click", "browser");
  const memReq = req("update_memory", "memory");
  const extReq = req("connector_call", "external");
  const vcsReq = req("git_commit", "vcs");

  // In "ask" mode: every change asks
  for (const q of [writeReq, editReq, readReq, shellReq, shellOutsideReq, delegateReq, netReq, browserReq, memReq, extReq, vcsReq]) {
    assert.equal(autoAllows("ask", q), false, `ask should ask: ${q.name} (${q.effect})`);
  }

  // In "auto_edit" mode: read, edit, shell, delegate pass without asking
  for (const q of [readReq, writeReq, editReq, shellReq, delegateReq]) {
    assert.equal(autoAllows("auto_edit", q), true, `auto_edit should allow: ${q.name} (${q.effect})`);
  }

  // In "auto_edit" mode: outside sandbox, network, browser, memory, external, vcs ask
  for (const q of [shellOutsideReq, netReq, browserReq, memReq, extReq, vcsReq]) {
    assert.equal(autoAllows("auto_edit", q), false, `auto_edit should ask: ${q.name} (${q.effect})`);
  }

  // In "auto" mode: all above proceed except shell_outside (unsandboxed shell always prompts, F1)
  for (const q of [readReq, writeReq, editReq, shellReq, delegateReq, netReq, browserReq, memReq, extReq, vcsReq]) {
    assert.equal(autoAllows("auto", q), true, `auto should allow: ${q.name} (${q.effect})`);
  }
  assert.equal(autoAllows("auto", shellOutsideReq), false, "auto must never allow shell_outside");

  // Hard stops in EVERY mode: control, spend, self
  for (const effect of ["control", "spend", "self"]) {
    assert.equal(autoAllows("auto", req("hard_stop_tool", effect)), false, `hard stop in auto: ${effect}`);
    assert.equal(autoAllows("auto_edit", req("hard_stop_tool", effect)), false, `hard stop in auto_edit: ${effect}`);
    assert.equal(autoAllows("ask", req("hard_stop_tool", effect)), false, `hard stop in ask: ${effect}`);
  }

  // Fail closed: a request with no effect or unclassified effect is asked in every mode
  assert.equal(autoAllows("auto", { name: "write_file", args: {} }), false, "name alone without effect must fail closed");
  assert.equal(autoAllows("auto", { effect: "made_up" }), false, "made_up effect must fail closed");
  assert.equal(autoAllows("auto_edit", { effect: "made_up" }), false);
  assert.equal(autoAllows("auto", {}), false);

  // Tainted shell: a shell command after reading untrusted web/connector content asks
  const tainted = { note: "Web content was read earlier in this run." };
  assert.equal(autoAllows("auto", { ...shellReq, ...tainted }), false, "tainted shell asks in auto");
  assert.equal(autoAllows("auto_edit", { ...shellReq, ...tainted }), false, "tainted shell asks in auto_edit");
  assert.equal(autoAllows("auto", { ...shellOutsideReq, ...tainted }), false, "tainted shell_outside asks in auto");
  // Non-shell actions are not blocked by the taint note
  assert.equal(autoAllows("auto", { ...writeReq, ...tainted }), true, "edit not blocked by taint note");
  assert.equal(autoAllows("auto_edit", { ...writeReq, ...tainted }), true);

  // Unknown mode (e.g. "full") returns false
  assert.equal(autoAllows("full", writeReq), false);
  assert.equal(autoAllows("all", writeReq), false);
  assert.equal(autoAllows("", writeReq), false);
});

test("F1: unsandboxed shell (shell_outside) is never auto-allowed in any mode", () => {
  assert.equal(autoAllows("auto", { effect: "shell_outside" }), false);
  assert.equal(autoAllows("auto_edit", { effect: "shell_outside" }), false);
  assert.equal(autoAllows("ask", { effect: "shell_outside" }), false);
  // Sandboxed shell in auto mode is unchanged.
  assert.equal(autoAllows("auto", { effect: "shell" }), true);
});

test("autoAllows engine_run policy", () => {
  const engineSandboxed = { name: "codex", effect: "engine_run", sandboxed: true };
  const engineUnsandboxed = { name: "workbuddy", effect: "engine_run", sandboxed: false };

  assert.equal(autoAllows("ask", engineSandboxed), false);
  assert.equal(autoAllows("auto_edit", engineSandboxed), true, "sandboxed engine run allowed on auto_edit");
  assert.equal(autoAllows("auto_edit", engineUnsandboxed), false, "unsandboxed engine run asks on auto_edit");
  assert.equal(autoAllows("auto", engineUnsandboxed), true, "auto allows unsandboxed engine run");
});

test("Always grant: 'always' for shell does not cover shell_outside, and shell_outside cannot be granted always", () => {
  const dummyContent = { version: 1 as const, epoch: 1, grants: [], updatedAt: Date.now(), updatedBy: "test" };
  const shellGrant = GrantsStore.newGrant(
    { tool: "exec_command", effect: "shell", scope: "git *", lifetime: "always" },
    dummyContent,
  );

  const grants = [shellGrant];
  assert.ok(isToolExecutionGranted(grants, { tool: "exec_command", command: "git status", effect: "shell" }));
  assert.ok(!isToolExecutionGranted(grants, { tool: "exec_command", command: "git status", effect: "shell_outside" }));

  // shell_outside cannot be granted with lifetime "always"
  assert.throws(
    () => GrantsStore.newGrant({ tool: "exec_command", effect: "shell_outside", scope: "*", lifetime: "always" }, dummyContent),
    /Cannot grant 'always' lifetime on shell_outside/,
  );
  assert.throws(
    () => GrantsStore.newGrant({ tool: "shell_outside", scope: "*", lifetime: "always" }, dummyContent),
    /Cannot grant 'always' lifetime on shell_outside/,
  );
});
