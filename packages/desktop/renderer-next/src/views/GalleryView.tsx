// Community Agent Store & Template Gallery (Phase 5 Row 20).
// Replaces the #viewGallery stub with searchable template cards, preview and publish modals.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ShellData, GalleryTemplate } from "../data";
import type { PublishGalleryInput } from "../data/gallery";
import {
  GALLERY_CATEGORIES,
  GALLERY_EMPTY_STATE,
  GALLERY_LOADING,
  PUBLISH_DEFAULT_AUTHOR,
  PUBLISH_FALLBACK_AUTHOR,
  PUBLISH_VALIDATION_MESSAGE,
  galleryCardView,
  parseTags,
  previewView,
  publishDescription,
  templateSlug,
} from "../../../src/shell/gallery-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface GalleryViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function GalleryView({ data, active, onSelect, refreshKey }: GalleryViewProps) {
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GalleryTemplate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name?: string; role?: string; systemPrompt?: string; allowedTools?: string[]; model?: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [publishCategory, setPublishCategory] = useState("engineering");
  const [tags, setTags] = useState("");
  const [author, setAuthor] = useState(PUBLISH_DEFAULT_AUTHOR);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async (nextCategory = category, nextQuery = search) => {
    try {
      setLoading(true);
      const list = await data.getGalleryTemplates({ category: nextCategory, query: nextQuery });
      setTemplates(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, refreshKey]);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void load(category, value.trim()), 250);
  };

  const handleCategory = (next: string) => {
    setCategory(next);
    void load(next, search.trim());
  };

  const handlePreview = async (template: GalleryTemplate) => {
    setPreview(template);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const full = await data.getGalleryTemplate(template.id);
      if (full) setPreview(full);
    } catch (err) {
      setPreviewError(errorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleInstall = async (template: GalleryTemplate) => {
    setInstallingId(template.id);
    setActionError(null);
    try {
      const res = await data.installGalleryTemplate(template.id);
      if (res?.agent !== undefined) await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setInstallingId(null);
    }
  };

  const handleOpenPublish = async () => {
    setPublishOpen(true);
    setAgentId("");
    setPublishCategory("engineering");
    setTags("");
    setAuthor(PUBLISH_DEFAULT_AUTHOR);
    setPublishError(null);
    try {
      const list = await data.getAgents();
      setAgents(Array.isArray(list) ? list : []);
    } catch {
      setAgents([]);
    }
  };

  const handlePublish = async () => {
    if (!agentId) {
      setPublishError(PUBLISH_VALIDATION_MESSAGE);
      return;
    }
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      setPublishError("Selected agent persona not found.");
      return;
    }
    const payload: PublishGalleryInput = {
      id: templateSlug(agent.name || "", agent.id),
      name: agent.name || agent.id,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      allowedTools: agent.allowedTools,
      model: agent.model,
      category: publishCategory,
      tags: parseTags(tags),
      author: author.trim() || PUBLISH_FALLBACK_AUTHOR,
      description: publishDescription(agent.role || "", agent.systemPrompt || ""),
    };
    setPublishing(true);
    setPublishError(null);
    try {
      await data.publishGalleryTemplate(payload);
      setPublishOpen(false);
      await load();
    } catch (err) {
      setPublishError(errorMessage(err));
    } finally {
      setPublishing(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      if (publishOpen) setPublishOpen(false);
      else setPreview(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [publishOpen]);

  const group = NAV_GROUPS.find((nav) => nav.tabs.some((tab) => tab.view === "gallery"));
  const previewData = preview ? previewView(preview) : null;

  return (
    <div id={viewPanelId("gallery")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container gallery-view-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "gallery" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "gallery" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">🌐 Community Agent Store &amp; Template Gallery</div>
            <div class="dashboard-subtitle">Discover, preview and install agent templates shared by the community.</div>
          </div>
          <button id="btnOpenPublishTemplate" type="button" class="btn btn-primary" onClick={() => void handleOpenPublish()}>
            Publish Template
          </button>
        </div>

        <div class="gallery-controls">
          <input
            id="gallerySearchInput"
            type="search"
            class="form-control"
            placeholder="Search templates…"
            value={search}
            onInput={(e) => handleSearch((e.currentTarget as HTMLInputElement).value)}
          />
          <div id="galleryCategoryChips" class="gallery-category-chips" role="group" aria-label="Template categories">
            {GALLERY_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                class={`category-chip${cat === category ? " active" : ""}`}
                data-category={cat}
                onClick={() => handleCategory(cat)}
              >
                {cat === "all" ? "All" : cat}
              </button>
            ))}
          </div>
          <button id="btnRefreshGallery" type="button" class="btn btn-ghost btn-xs" onClick={() => void load()}>Refresh</button>
        </div>

        {loadError && (
          <div class="gallery-error" role="alert">
            <span>Error loading template store: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {actionError && <div class="gallery-error" role="alert">{actionError}</div>}

        <div class="gallery-grid" id="galleryCardGrid">
          {loading ? (
            <div class="gallery-empty">{GALLERY_LOADING}</div>
          ) : templates.length === 0 ? (
            <div class="gallery-empty">{GALLERY_EMPTY_STATE}</div>
          ) : (
            templates.map((template) => {
              const card = galleryCardView(template);
              return (
                <div class="gallery-template-card" key={template.id}>
                  <div class="gallery-card-top">
                    <div class="gallery-card-icon">{card.icon}</div>
                    <div class="gallery-card-info">
                      <div class="gallery-card-title">{card.title}</div>
                      <div class="gallery-card-role">{card.role}</div>
                    </div>
                  </div>
                  <div class="gallery-card-desc">{card.description}</div>
                  <div class="gallery-card-tags">
                    {card.tags.map((tag, index) => <span class="gallery-tag-pill" key={`${tag}-${index}`}>#{tag}</span>)}
                  </div>
                  <div class="gallery-card-meta">
                    <span class="gallery-stat">⭐ {card.rating}</span>
                    <span class="gallery-stat">📥 {card.downloads}</span>
                    <span class="gallery-stat">👤 {card.author}</span>
                    <span class={`badge ${card.badgeClass}`}>{card.badge}</span>
                  </div>
                  <div class="gallery-card-actions">
                    <button type="button" class="btn btn-secondary btn-xs btn-preview-tpl" onClick={() => void handlePreview(template)}>
                      Preview
                    </button>
                    {card.installed ? (
                      <button type="button" class="btn btn-ghost btn-xs" disabled>Installed ✓</button>
                    ) : (
                      <button type="button" class="btn btn-primary btn-xs btn-install-tpl"
                        disabled={installingId === template.id}
                        onClick={() => void handleInstall(template)}>
                        {installingId === template.id ? "Installing…" : "Install to Fleet"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="templatePreviewModal"
        class={`modal-overlay${preview ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="previewModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="previewModalTitle">{previewData?.title || "Template Preview"}</h3>
            <button id="btnClosePreviewModal" type="button" class="btn-close" aria-label="Close template preview" onClick={() => setPreview(null)}>&times;</button>
          </div>
          <div class="modal-body">
            {previewLoading && <div class="gallery-loading">Loading template details…</div>}
            {previewError && <div class="gallery-error" role="alert">{previewError}</div>}
            {previewData && !previewLoading && (
              <>
                <div class="gallery-preview-head">
                  <span class="gallery-card-icon" id="previewModalIcon">{previewData.icon}</span>
                  <span id="previewModalRole">{previewData.role}</span>
                </div>
                <p id="previewModalDesc" class="gallery-preview-desc">{previewData.description}</p>
                <div id="previewModalMeta" class="gallery-preview-badges">
                  {previewData.badges.map((badge, index) => <span class="badge" key={`${badge}-${index}`}>{badge}</span>)}
                </div>
                <h4>Capabilities</h4>
                <div id="previewModalTools" class="gallery-preview-badges">
                  {previewData.tools.length
                    ? previewData.tools.map((tool, index) => <span class="badge" key={`${tool}-${index}`}>{tool}</span>)
                    : <span class="gallery-muted">All available workspace tools</span>}
                </div>
                <h4>Suggested tasks</h4>
                <ul id="previewModalTasks">
                  {previewData.tasks.length
                    ? previewData.tasks.map((task, index) => <li key={`${task}-${index}`}>{task}</li>)
                    : <li>General domain engineering tasks and workflows</li>}
                </ul>
                <h4>System prompt</h4>
                <pre id="previewModalPrompt" class="gallery-prompt">{previewData.prompt}</pre>
              </>
            )}
          </div>
          <div class="modal-actions">
            <button id="btnInstallFromPreview" type="button" class="btn btn-primary"
              disabled={!previewData || previewData.installed || installingId !== null}
              onClick={() => { if (preview) void handleInstall(preview); }}>
              {previewData?.installed ? "Already Installed in Fleet" : "Install to Local Fleet"}
            </button>
            <button id="btnCancelPreviewModal" type="button" class="btn btn-ghost" onClick={() => setPreview(null)}>Close</button>
          </div>
        </div>
      </div>

      <div
        id="publishTemplateModal"
        class={`modal-overlay${publishOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publishTemplateTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="publishTemplateTitle">Publish Agent to Community Gallery</h3>
            <button id="btnClosePublishModal" type="button" class="btn-close" aria-label="Close publish dialog" onClick={() => setPublishOpen(false)}>&times;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="publishAgentSelect">Select Local Agent</label>
              <select id="publishAgentSelect" class="form-control" value={agentId}
                onChange={(e) => setAgentId((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">Choose a persona…</option>
                {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name || agent.id}</option>)}
              </select>
            </div>
            <div class="form-group">
              <label for="publishCategory">Category</label>
              <select id="publishCategory" class="form-control" value={publishCategory}
                onChange={(e) => setPublishCategory((e.currentTarget as HTMLSelectElement).value)}>
                <option value="engineering">🛠️ Engineering</option>
                <option value="security">🛡️ Security</option>
                <option value="product">📐 Product</option>
                <option value="research">🔬 Research</option>
              </select>
            </div>
            <div class="form-group">
              <label for="publishTags">Tags (comma-separated)</label>
              <input id="publishTags" type="text" class="form-control" value={tags}
                onInput={(e) => setTags((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="publishAuthor">Author / Contributor Handle</label>
              <input id="publishAuthor" type="text" class="form-control" value={author}
                onInput={(e) => setAuthor((e.currentTarget as HTMLInputElement).value)} />
            </div>
            {publishError && <div class="gallery-error" role="alert">{publishError}</div>}
          </div>
          <div class="modal-actions">
            <button id="btnCancelPublishModal" type="button" class="btn btn-ghost" onClick={() => setPublishOpen(false)}>Cancel</button>
            <button id="btnSubmitPublish" type="button" class="btn btn-primary" disabled={publishing}
              onClick={() => void handlePublish()}>
              {publishing ? "Publishing…" : "Publish to Gallery"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
