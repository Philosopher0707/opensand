// Modular Recipe Skills view (Phase 5 Row 15).
// Replaces the #viewSkills stub with the skill grid, create modal and in-app recipe preview.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, Skill, CreateSkillInput } from "../data";
import {
  SKILL_EMPTY_STATE,
  skillCardView,
  validateCreateSkillInput,
  createInitialModalState,
  openCreateSkillModal,
  closeCreateSkillModal,
  openSkillPreview,
  closeSkillPreview,
} from "../../../src/shell/skills-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface SkillsViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SkillsView({ data, active, onSelect, refreshKey }: SkillsViewProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await data.getSkills();
        if (cancelled) return;
        setSkills(Array.isArray(list) ? list : []);
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

  // One stable listener: re-attaching on every modal state change can miss a fast reopen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      setModals((state) => {
        if (state.previewSkill) return closeSkillPreview(state);
        if (state.createSkillModalOpen) return closeCreateSkillModal(state);
        return state;
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reload = async () => {
    try {
      const list = await data.getSkills();
      setSkills(Array.isArray(list) ? list : []);
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const handleOpenCreate = () => {
    setName("");
    setDescription("");
    setContent("");
    setCreateError(null);
    setModals((state) => openCreateSkillModal(state));
  };

  const handleCreate = async () => {
    const input: CreateSkillInput = { name, description, content };
    const validation = validateCreateSkillInput(input);
    if (validation) {
      setCreateError(validation);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await data.createSkill(input);
      setModals((state) => closeCreateSkillModal(state));
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (skill: Skill) => {
    if (!window.confirm(`Delete skill "${skill.name || skill.id}"?`)) return;
    try {
      await data.deleteSkill(skill.id);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const capabilities = NAV_GROUPS.find((group) => group.id === "capabilities");

  return (
    <div id={viewPanelId("skills")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container skills-view-container">
        {capabilities && (
          <nav class="subnav-tabs" data-group={capabilities.id} aria-label="Capabilities views">
            {capabilities.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "skills" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "skills" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">📦 Modular Recipe Skills Library</div>
            <div class="dashboard-subtitle">
              Modular SKILL.md recipe guidelines with YAML frontmatter mounted to agent personas.
            </div>
          </div>
          <button id="btnOpenCreateSkill" type="button" class="btn btn-primary" onClick={handleOpenCreate}>
            + New Skill
          </button>
        </div>

        {loadError && (
          <div class="skills-error" role="alert">
            <span>Could not load skills: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="card-grid" id="skillsCardGrid">
          {loading ? (
            <div class="skills-loading">Loading skills…</div>
          ) : skills.length === 0 ? (
            <div class="skills-empty">{SKILL_EMPTY_STATE}</div>
          ) : (
            skills.map((skill) => {
              const card = skillCardView(skill);
              return (
                <div class="dashboard-card" key={skill.id}>
                  <div class="card-top">
                    <div class="card-title">📦 {card.title}</div>
                    <span class="badge">{card.category}</span>
                  </div>
                  <div class="card-desc">{card.description}</div>
                  <div class="card-meta">
                    <span class="badge">{card.origin}</span>
                    <span class="badge">{card.bytesLabel}</span>
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-secondary btn-xs btn-preview-skill"
                      onClick={() => setModals((state) => openSkillPreview(state, skill))}
                    >
                      View Recipe
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-del-skill"
                      onClick={() => void handleDelete(skill)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="createSkillModal"
        class={`modal-overlay${modals.createSkillModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createSkillModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createSkillModalTitle">Create Modular Recipe Skill</h3>
            <button
              id="btnCloseCreateSkill"
              type="button"
              class="btn-close"
              aria-label="Close create skill dialog"
              onClick={() => setModals((state) => closeCreateSkillModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="skillName">Skill Name (or frontmatter slug)</label>
              <input
                type="text"
                id="skillName"
                class="form-control"
                placeholder="e.g. postgresql-tuning"
                value={name}
                onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="skillDescription">Description</label>
              <input
                type="text"
                id="skillDescription"
                class="form-control"
                placeholder="e.g. Performance query tuning and indexing guidelines"
                value={description}
                onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="skillContent">Content / SKILL.md Markdown (Supports YAML Frontmatter)</label>
              <textarea
                id="skillContent"
                class="form-control"
                rows={6}
                placeholder={"---\nname: postgresql-tuning\ndescription: Query tuning\n---\n# Recipe..."}
                value={content}
                onInput={(e) => setContent((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            <div id="skillsFormError" class="skills-form-error" role={createError ? "alert" : undefined}>
              {createError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveSkill"
              type="button"
              class="btn btn-primary"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Creating..." : "Save Skill"}
            </button>
          </div>
        </div>
      </div>

      <div
        id="skillPreviewModal"
        class={`modal-overlay${modals.previewSkill ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skillPreviewTitle"
      >
        <div class="modal-card skill-preview-card">
          <div class="modal-header">
            <h3 id="skillPreviewTitle">{modals.previewSkill?.name || modals.previewSkill?.id || "Recipe"}</h3>
            <button
              id="btnCloseSkillPreview"
              type="button"
              class="btn-close"
              aria-label="Close recipe preview"
              onClick={() => setModals((state) => closeSkillPreview(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <pre class="skill-preview-content">{modals.previewSkill?.content || ""}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
