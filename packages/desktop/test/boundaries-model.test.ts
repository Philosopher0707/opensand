import test from "node:test";
import assert from "node:assert";
import {
  AUDIT_EMPTY_STATE,
  POLICY_EMPTY_STATE,
  RULE_VALIDATION_MESSAGE,
  auditEntryView,
  closeCreateRuleModal,
  createInitialModalState,
  openCreateRuleModal,
  parseList,
  policyActionClass,
  policyCardView,
  validateCreateRuleInput,
  type CreateRuleInput,
} from "../src/shell/boundaries-model.js";

const valid: CreateRuleInput = { id: "rule_1", name: "no push", action: "DENY", enabled: true };

test("boundaries-model: validation requires a rule name", () => {
  assert.strictEqual(validateCreateRuleInput(valid), null);
  assert.strictEqual(validateCreateRuleInput({ ...valid, name: "" }), RULE_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateRuleInput({ ...valid, name: "  \n " }), RULE_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateRuleInput({ ...valid, name: " no push " }), null);
});

test("boundaries-model: free-text lists become trimmed arrays", () => {
  assert.strictEqual(parseList(""), undefined);
  assert.strictEqual(parseList("  "), undefined);
  assert.deepStrictEqual(parseList(" bash , rm ,  "), ["bash", "rm"]);
  assert.deepStrictEqual(parseList("/tmp , /var"), ["/tmp", "/var"]);
});

test("boundaries-model: action badge classes and card badges", () => {
  assert.strictEqual(policyActionClass("DENY"), "badge-danger");
  assert.strictEqual(policyActionClass("REQUIRE_APPROVAL"), "badge-warning");
  assert.strictEqual(policyActionClass("ALLOW"), "badge-success");
  assert.strictEqual(policyActionClass(undefined), "badge-success");

  assert.deepStrictEqual(policyCardView({ id: "rule_2" }), {
    title: "rule_2", action: "ALLOW", actionClass: "badge-success", description: "No description.", badges: [],
  });
  const card = policyCardView({ id: "rule_3", name: " Gate ", action: "DENY", description: " block shell ",
    tools: ["bash", "rm"], commandRegex: " rm ", pathsPrefix: ["/etc"] });
  assert.strictEqual(card.title, "Gate");
  assert.strictEqual(card.description, "block shell");
  assert.deepStrictEqual(card.badges, ["Tools: bash, rm", "Regex: rm", "Paths: /etc"]);
});

test("boundaries-model: audit entries map decision to tone", () => {
  const denied = auditEntryView({ decision: "DENIED", toolName: "exec", ruleName: "no push", reason: "blocked",
    argsSummary: "cmd", timestamp: 0 });
  assert.strictEqual(denied.className, "boundary-item fail");
  assert.strictEqual(denied.statusClass, "status-badge fail");
  assert.strictEqual(denied.decision, "DENIED");
  assert.strictEqual(denied.title, "Tool: exec");
  assert.strictEqual(denied.ruleLabel, "(Rule: no push)");
  assert.strictEqual(denied.argsSummary, "cmd");

  assert.strictEqual(auditEntryView({ decision: "REQUIRE_APPROVAL" }).className, "boundary-item warn");
  const allowed = auditEntryView({ timestamp: 1000 });
  assert.strictEqual(allowed.decision, "ALLOWED");
  assert.strictEqual(allowed.className, "boundary-item clean");
  assert.strictEqual(allowed.ruleLabel, "");
});

test("boundaries-model: modal helpers and empty states", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { createRuleModalOpen: false });
  const opened = openCreateRuleModal(initial);
  assert.deepStrictEqual(opened, { createRuleModalOpen: true });
  assert.deepStrictEqual(closeCreateRuleModal(opened), initial);
  assert.ok(POLICY_EMPTY_STATE.includes("Fail-closed"));
  assert.ok(AUDIT_EMPTY_STATE.includes("No policy evaluations"));
});
