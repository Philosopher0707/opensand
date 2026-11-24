// Pure model for the Fail-Closed Boundaries view (Phase 5 Row 23).
// Mirrors the legacy renderer/app.js boundary controller without DOM or bridge code.

export type PolicyAction = "DENY" | "REQUIRE_APPROVAL" | "ALLOW";

export interface PolicyRule {
  id: string;
  name?: string;
  action?: PolicyAction | string;
  description?: string;
  tools?: string[];
  commandRegex?: string;
  pathsPrefix?: string[];
  enabled?: boolean;
  [key: string]: unknown;
}

export interface PolicyAuditEntry {
  decision?: string;
  toolName?: string;
  ruleName?: string;
  reason?: string;
  argsSummary?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface CreateRuleInput {
  id: string;
  name: string;
  action: PolicyAction | string;
  tools?: string[];
  commandRegex?: string;
  pathsPrefix?: string[];
  description?: string;
  enabled: boolean;
}

export interface PolicyCardView {
  title: string;
  action: string;
  actionClass: string;
  description: string;
  badges: string[];
}

export interface AuditEntryView {
  className: string;
  statusClass: string;
  decision: string;
  title: string;
  ruleLabel: string;
  time: string;
  reason: string;
  argsSummary: string;
}

export interface BoundariesModalState {
  createRuleModalOpen: boolean;
}

export const RULE_VALIDATION_MESSAGE = "Please specify a rule name.";
export const POLICY_EMPTY_STATE = "No boundary policy rules defined. Fail-closed defaults apply.";
export const AUDIT_EMPTY_STATE =
  "No policy evaluations logged yet. Tool executions evaluate against fail-closed boundaries automatically.";

/** Matches the legacy `trim()` then `split(',')` parsing of free-text fields. */
export function parseList(raw: string): string[] | undefined {
  const list = raw.trim() ? raw.split(",").map((item) => item.trim()).filter(Boolean) : [];
  return list.length ? list : undefined;
}

export function validateCreateRuleInput(input: CreateRuleInput): string | null {
  return input.name?.trim() ? null : RULE_VALIDATION_MESSAGE;
}

export function policyActionClass(action?: string): string {
  if (action === "DENY") return "badge-danger";
  if (action === "REQUIRE_APPROVAL") return "badge-warning";
  return "badge-success";
}

export function policyCardView(rule: PolicyRule): PolicyCardView {
  const badges: string[] = [];
  if (rule.tools?.length) badges.push(`Tools: ${rule.tools.join(", ")}`);
  if (rule.commandRegex?.trim()) badges.push(`Regex: ${rule.commandRegex.trim()}`);
  if (rule.pathsPrefix?.length) badges.push(`Paths: ${rule.pathsPrefix.join(", ")}`);
  return {
    title: rule.name?.trim() || rule.id || "Untitled rule",
    action: rule.action || "ALLOW",
    actionClass: policyActionClass(rule.action),
    description: rule.description?.trim() || "No description.",
    badges,
  };
}

export function auditEntryView(entry: PolicyAuditEntry): AuditEntryView {
  const tone = entry.decision === "DENIED" ? "fail" : entry.decision === "REQUIRE_APPROVAL" ? "warn" : "clean";
  return {
    className: `boundary-item ${tone}`,
    statusClass: `status-badge ${tone}`,
    decision: entry.decision || "ALLOWED",
    title: `Tool: ${entry.toolName || "unknown"}`,
    ruleLabel: entry.ruleName ? `(Rule: ${entry.ruleName})` : "",
    time: new Date(entry.timestamp || Date.now()).toLocaleTimeString(),
    reason: entry.reason || "",
    argsSummary: entry.argsSummary || "",
  };
}

export function createInitialModalState(): BoundariesModalState {
  return { createRuleModalOpen: false };
}

export function openCreateRuleModal(state: BoundariesModalState): BoundariesModalState {
  return { ...state, createRuleModalOpen: true };
}

export function closeCreateRuleModal(state: BoundariesModalState): BoundariesModalState {
  return { ...state, createRuleModalOpen: false };
}
