// 7-Layer Memory & Team Review Queue view (Phase 5 Row 17).
// Replaces the #viewMemories legacy stub with Preact cards, inline validation, and review queue actions.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  MEMORY_VALIDATION_MESSAGE,
  TEAM_REVIEW_EMPTY_STATE,
  MEMORIES_EMPTY_STATE,
  type MemoryFact,
  type ReviewItem,
  type CreateMemoryInput,
  type MemoryScope,
  type MemoryTier,
  validateMemoryInput,
  reviewCardView,
  memoryCardView,
  createInitialModalState,
  openAddMemoryModal,
  closeAddMemoryModal,
} from "../../../src/shell/memories-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface MemoriesViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function MemoriesView({ data, active, onSelect, refreshKey }: MemoriesViewProps) {
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  // Form inputs
  const [text, setText] = useState("");
  const [scope, setScope] = useState<MemoryScope>("user");
  const [tier, setTier] = useState<MemoryTier>("preference");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    try {
      const [revItems, memFacts] = await Promise.all([
        data.getTeamReviewItems(),
        data.getMemories(),
      ]);
      setReviewItems(Array.isArray(revItems) ? revItems : []);
      setMemories(Array.isArray(memFacts) ? memFacts : []);
    } catch {
      // Keep last successful lists on reload failure
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [revItems, memFacts] = await Promise.all([
          data.getTeamReviewItems(),
          data.getMemories(),
        ]);
        if (cancelled) return;
        setReviewItems(Array.isArray(revItems) ? revItems : []);
        setMemories(Array.isArray(memFacts) ? memFacts : []);
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
  }, [data, refreshKey, active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      setModals((state) => {
        if (state.addMemoryModalOpen) return closeAddMemoryModal(state);
        return state;
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleOpenAddMemory = () => {
    setText("");
    setScope("user");
    setTier("preference");
    setFormError(null);
    setModals(openAddMemoryModal);
  };

  const handleSaveMemory = async () => {
    const input: CreateMemoryInput = { text, scope, tier };
    const validation = validateMemoryInput(input);
    if (validation) {
      setFormError(validation);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await data.addMemory(input);
      setModals(closeAddMemoryModal);
      await reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleResolveReview = async (itemId: string, decision: "approve" | "reject") => {
    try {
      await data.resolveReviewItem(itemId, decision);
      await reload();
    } catch {
      // Keep state on failure
    }
  };

  const handleForget = async (fact: MemoryFact) => {
    if (!window.confirm("Forget this memory fact?")) return;
    try {
      await data.forgetMemory(fact.id, fact.scope as string);
      await reload();
    } catch {
      // Keep state on failure
    }
  };

  const capabilities = NAV_GROUPS.find((group) => group.id === "capabilities");

  return (
    <div id={viewPanelId("memories")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container memories-view-container">
        {capabilities && (
          <nav class="subnav-tabs" data-group={capabilities.id} aria-label="Capabilities views">
            {capabilities.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "memories" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "memories" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">7-Layer Memory & Team Review Queue</div>
            <div class="dashboard-subtitle">
              Discrete facts across user, agent, and team tiers with human-in-the-loop review governance.
            </div>
          </div>
          <button id="btnOpenAddMemory" type="button" class="btn btn-primary" onClick={handleOpenAddMemory}>
            + Add Memory Fact
          </button>
        </div>

        {loadError && (
          <div class="memories-error" role="alert">
            <span>Could not load memories: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="sidebar-section-title" style="margin-top: 10px;">
          Team Review Queue (Proposals Awaiting Approval)
        </div>
        <div class="card-grid" id="teamReviewGrid">
          {loading ? (
            <div class="memories-loading">Loading proposals…</div>
          ) : reviewItems.length === 0 ? (
            <div class="memories-empty">{TEAM_REVIEW_EMPTY_STATE}</div>
          ) : (
            reviewItems.map((item) => {
              const card = reviewCardView(item);
              return (
                <div class="dashboard-card" key={item.id}>
                  <div class="card-top">
                    <div class="card-title">📝 {card.title}</div>
                    <span class="badge badge-warning">{card.status}</span>
                  </div>
                  <div class="card-desc">{card.text}</div>
                  <div class="card-meta">
                    <span class="badge">Proposed by: {card.proposedBy}</span>
                    <span class="badge">Tier: {card.tier}</span>
                  </div>
                  <div class="card-footer">
                    <div style="display: flex; gap: 6px;">
                      <button
                        type="button"
                        class="btn btn-primary btn-xs btn-approve-rev"
                        onClick={() => void handleResolveReview(item.id, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs btn-reject-rev"
                        style="color: var(--danger);"
                        onClick={() => void handleResolveReview(item.id, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div class="sidebar-section-title" style="margin-top: 20px;">
          Active Memory Facts
        </div>
        <div class="card-grid" id="memoriesGrid">
          {loading ? (
            <div class="memories-loading">Loading memory facts…</div>
          ) : memories.length === 0 ? (
            <div class="memories-empty">{MEMORIES_EMPTY_STATE}</div>
          ) : (
            memories.map((m) => {
              const card = memoryCardView(m);
              return (
                <div class="dashboard-card" key={m.id}>
                  <div class="card-top">
                    <div class="card-title">{card.tierTitle}</div>
                    <span class="badge badge-bot">{card.scopeBadge}</span>
                  </div>
                  <div class="card-desc">{card.text}</div>
                  <div class="card-meta">
                    <span class="badge">{card.confidenceLabel}</span>
                    <span class="badge">{card.dateLabel}</span>
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-forget-mem"
                      style="color: var(--danger);"
                      onClick={() => void handleForget(m)}
                    >
                      Forget
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="addMemoryModal"
        class={`modal-overlay${modals.addMemoryModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="addMemoryModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="addMemoryModalTitle">Add Memory Fact</h3>
            <button
              id="btnCloseAddMemory"
              type="button"
              class="btn-close"
              aria-label="Close add memory dialog"
              onClick={() => setModals(closeAddMemoryModal)}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="memText">Fact / Invariant</label>
              <textarea
                id="memText"
                class="form-control"
                rows={3}
                placeholder="e.g. Always format commit messages with conventional commits"
                value={text}
                onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="memScope">Scope</label>
              <select
                id="memScope"
                class="form-control"
                value={scope}
                onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value as MemoryScope)}
              >
                <option value="user">User</option>
                <option value="agent">Agent</option>
                <option value="team">Team</option>
              </select>
            </div>
            <div class="form-group">
              <label for="memTier">Memory Tier</label>
              <select
                id="memTier"
                class="form-control"
                value={tier}
                onChange={(e) => setTier((e.currentTarget as HTMLSelectElement).value as MemoryTier)}
              >
                <option value="preference">Preference</option>
                <option value="profile">Profile</option>
                <option value="guideline">Guideline</option>
                <option value="rule">Rule</option>
              </select>
            </div>
            <div id="memoriesFormError" class="memories-form-error" role={formError ? "alert" : undefined}>
              {formError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveMemory"
              type="button"
              class="btn btn-primary"
              disabled={saving}
              onClick={() => void handleSaveMemory()}
            >
              {saving ? "Saving..." : "Save Memory"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
