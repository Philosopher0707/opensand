// Fail-Closed Boundaries view (Phase 5 Row 23).
// Replaces the #viewBoundaries stub with the policy grid, audit feed and create modal.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, PolicyRule, PolicyAuditEntry, PolicyAction } from "../data";
import {
  AUDIT_EMPTY_STATE,
  POLICY_EMPTY_STATE,
  RULE_VALIDATION_MESSAGE,
  auditEntryView,
  closeCreateRuleModal,
  createInitialModalState,
  openCreateRuleModal,
  parseList,
  policyCardView,
  validateCreateRuleInput,
} from "../../../src/shell/boundaries-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface BoundariesViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function BoundariesView({ data, active, onSelect, refreshKey }: BoundariesViewProps) {
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [audit, setAudit] = useState<PolicyAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [name, setName] = useState("");
  const [action, setAction] = useState<string>("DENY");
  const [tool, setTool] = useState("");
  const [commandRegex, setCommandRegex] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [rules, feed] = await Promise.all([data.getPolicies(), data.getPolicyAudit()]);
        if (cancelled) return;
        setPolicies(Array.isArray(rules) ? rules : []);
        setAudit(Array.isArray(feed) ? feed : []);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, refreshKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      setModals((state) => closeCreateRuleModal(state));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reload = async () => {
    try {
      setLoading(true);
      const [rules, feed] = await Promise.all([data.getPolicies(), data.getPolicyAudit()]);
      setPolicies(Array.isArray(rules) ? rules : []);
      setAudit(Array.isArray(feed) ? feed : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreate = () => {
    setName("");
    setAction("DENY");
    setTool("");
    setCommandRegex("");
    setPathPrefix("");
    setDescription("");
    setCreateError(null);
    setModals((state) => openCreateRuleModal(state));
  };

  const handleCreate = async () => {
    const input = {
      id: `rule_${Date.now()}`,
      name,
      action: action as PolicyAction,
      tools: parseList(tool),
      commandRegex: commandRegex.trim() || undefined,
      pathsPrefix: parseList(pathPrefix),
      description: description.trim() || undefined,
      enabled: true,
    };
    const validation = validateCreateRuleInput(input);
    if (validation) {
      setCreateError(validation);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await data.createPolicy(input);
      setModals((state) => closeCreateRuleModal(state));
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (rule: PolicyRule) => {
    if (!window.confirm(`Delete policy rule "${rule.name}"?`)) return;
    try {
      await data.deletePolicy(rule.id);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const group = NAV_GROUPS.find((nav) => nav.tabs.some((tab) => tab.view === "boundaries"));

  return (
    <div id={viewPanelId("boundaries")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container boundaries-view-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "boundaries" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "boundaries" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">🚧 Fail-Closed Policy Boundaries</div>
            <div class="dashboard-subtitle">
              Deny, gate or allow tool calls with explicit rules; every evaluation is recorded.
            </div>
          </div>
          <button id="btnRefreshBoundaries" type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>
            Refresh
          </button>
          <button id="btnOpenCreateRule" type="button" class="btn btn-primary" onClick={handleOpenCreate}>
            + New Rule
          </button>
        </div>

        {loadError && (
          <div class="boundaries-error" role="alert">
            <span>Could not load boundaries: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="card-grid" id="boundariesCardGrid">
          {loading ? (
            <div class="boundaries-loading">Loading rules…</div>
          ) : policies.length === 0 ? (
            <div class="boundaries-empty">{POLICY_EMPTY_STATE}</div>
          ) : (
            policies.map((rule) => {
              const card = policyCardView(rule);
              return (
                <div class="dashboard-card" key={rule.id}>
                  <div class="card-top">
                    <div class="card-title">{card.title}</div>
                    <span class={`badge ${card.actionClass}`}>{card.action}</span>
                  </div>
                  <div class="card-desc">{card.description}</div>
                  <div class="card-meta">
                    {card.badges.map((badge, index) => <span class="badge" key={`${badge}-${index}`}>{badge}</span>)}
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-delete-rule"
                      onClick={() => void handleDelete(rule)}
                    >
                      Delete Rule
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <h3 class="boundaries-section-title">Policy Audit</h3>
        <div class="boundaries-feed" id="boundariesAuditFeed">
          {loading ? (
            <div class="boundaries-loading">Loading audit…</div>
          ) : audit.length === 0 ? (
            <div class="boundaries-empty">{AUDIT_EMPTY_STATE}</div>
          ) : (
            audit.slice(-25).reverse().map((entry, index) => {
              const view = auditEntryView(entry);
              return (
                <div class={view.className} key={`${view.time}-${index}`}>
                  <div class="boundary-header-row">
                    <div>
                      <span class={view.statusClass}>{view.decision}</span>
                      <strong class="boundary-title">{view.title}</strong>
                      {view.ruleLabel && <span class="boundary-rule">{view.ruleLabel}</span>}
                    </div>
                    <span class="boundary-time">{view.time}</span>
                  </div>
                  <div class="boundary-reason">{view.reason}</div>
                  {view.argsSummary && <pre class="boundary-output-box">{view.argsSummary}</pre>}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="createRuleModal"
        class={`modal-overlay${modals.createRuleModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createRuleModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createRuleModalTitle">Create Policy Rule</h3>
            <button
              id="btnCloseCreateRule"
              type="button"
              class="btn-close"
              aria-label="Close create rule dialog"
              onClick={() => setModals((state) => closeCreateRuleModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="ruleName">Rule name</label>
              <input type="text" id="ruleName" class="form-control" value={name}
                onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="ruleAction">Action</label>
              <select id="ruleAction" class="form-control" value={action}
                onChange={(e) => setAction((e.currentTarget as HTMLSelectElement).value)}>
                <option value="DENY">Deny</option>
                <option value="REQUIRE_APPROVAL">Require approval</option>
                <option value="ALLOW">Allow</option>
              </select>
            </div>
            <div class="form-group">
              <label for="ruleTool">Tools (comma-separated)</label>
              <input type="text" id="ruleTool" class="form-control" value={tool}
                onInput={(e) => setTool((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="ruleCommandRegex">Command regex</label>
              <input type="text" id="ruleCommandRegex" class="form-control" value={commandRegex}
                onInput={(e) => setCommandRegex((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="rulePathPrefix">Path prefixes (comma-separated)</label>
              <input type="text" id="rulePathPrefix" class="form-control" value={pathPrefix}
                onInput={(e) => setPathPrefix((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="ruleDesc">Description</label>
              <input type="text" id="ruleDesc" class="form-control" value={description}
                onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div id="ruleFormError" class="boundaries-form-error" role={createError ? "alert" : undefined}>
              {createError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button id="btnSaveRule" type="button" class="btn btn-primary" disabled={creating}
              onClick={() => void handleCreate()}>
              {creating ? "Saving..." : "Save Rule"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
