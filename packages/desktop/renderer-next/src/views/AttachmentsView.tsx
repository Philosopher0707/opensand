// Staged Context Attachments view (Phase 5 Row 18).
// Replaces the #viewAttachments stub with the legacy card grid and the stage-attachment modal.
import { useEffect, useState } from "preact/hooks";
import type { Attachment } from "../data";
import {
  ATTACHMENT_EMPTY_STATE,
  attachmentCardView,
  closeStageAttachmentModal,
  createInitialModalState,
  openStageAttachmentModal,
  unstageConfirmMessage,
  validateStageAttachmentInput,
} from "../../../src/shell/attachments-model";
import { NAV_GROUPS, viewPanelId } from "../../../src/shell/navigation-model";
import type { ViewProps } from "./registry";

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AttachmentsView({ data, active, onSelect, refreshKey }: ViewProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [filePath, setFilePath] = useState("");
  const [stageError, setStageError] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await data.getAttachments();
        if (cancelled) return;
        setAttachments(Array.isArray(list) ? list : []);
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
      setModals((state) => (state.stageAttachmentModalOpen ? closeStageAttachmentModal(state) : state));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reload = async () => {
    try {
      const list = await data.getAttachments();
      setAttachments(Array.isArray(list) ? list : []);
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const handleOpenStage = () => {
    setFilePath("");
    setStageError(null);
    setModals((state) => openStageAttachmentModal(state));
  };

  const handleStage = async () => {
    const validation = validateStageAttachmentInput(filePath);
    if (validation) {
      setStageError(validation);
      return;
    }
    setStaging(true);
    setStageError(null);
    try {
      await data.stageAttachment(filePath);
      setModals((state) => closeStageAttachmentModal(state));
      await reload();
    } catch (err) {
      setStageError(errorMessage(err));
    } finally {
      setStaging(false);
    }
  };

  const handleUnstage = async (att: Attachment) => {
    if (!window.confirm(unstageConfirmMessage(att))) return;
    try {
      await data.deleteAttachment(att.id);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  // The legacy view places attachments in the Connections subnav; NAV_GROUPS is the code source of truth.
  const connections = NAV_GROUPS.find((group) => group.id === "connections");

  return (
    <div id={viewPanelId("attachments")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container attachments-view-container">
        {connections && (
          <nav class="subnav-tabs" data-group={connections.id} aria-label="Connections views">
            {connections.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "attachments" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "attachments" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">📎 Staged Context Attachments</div>
            <div class="dashboard-subtitle">
              Grok Bot Parity: File staging and deterministic SHA-256 byte digest context attachments.
            </div>
          </div>
          <button id="btnOpenStageAttachment" type="button" class="btn btn-primary" onClick={handleOpenStage}>
            + Stage Attachment
          </button>
        </div>

        {loadError && (
          <div class="attachments-error" role="alert">
            <span>Could not load attachments: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="card-grid" id="attachmentsCardGrid">
          {loading ? (
            <div class="attachments-loading">Loading attachments…</div>
          ) : attachments.length === 0 ? (
            <div class="attachments-empty">{ATTACHMENT_EMPTY_STATE}</div>
          ) : (
            attachments.map((att) => {
              const card = attachmentCardView(att);
              return (
                <div class="dashboard-card" key={att.id}>
                  <div class="card-top">
                    <div class="card-title">📎 {card.title}</div>
                    <span class="badge badge-success">Staged</span>
                  </div>
                  <div class="card-desc attachment-path" title={card.pathLabel}>
                    <strong>Path:</strong> {card.pathLabel}
                  </div>
                  <div class="card-meta">
                    <span class="badge">{card.sizeLabel}</span>
                    <span class="attachment-hash" title="SHA-256 Digest">{card.hashLabel}</span>
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-del-att"
                      onClick={() => void handleUnstage(att)}
                    >
                      Unstage
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="stageAttachmentModal"
        class={`modal-overlay${modals.stageAttachmentModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stageAttachmentModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="stageAttachmentModalTitle">📎 Stage Context Attachment</h3>
            <button
              id="btnCloseStageAttachment"
              type="button"
              class="btn-close"
              aria-label="Close stage attachment dialog"
              onClick={() => setModals((state) => closeStageAttachmentModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="attachmentFilePath">Local File Path</label>
              <input
                type="text"
                id="attachmentFilePath"
                class="form-control"
                placeholder="e.g. /Users/philosopher/dev/project/schema.sql"
                value={filePath}
                onInput={(e) => setFilePath((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div id="attachmentsFormError" class="attachments-form-error" role={stageError ? "alert" : undefined}>
              {stageError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveStageAttachment"
              type="button"
              class="btn btn-primary"
              disabled={staging}
              onClick={() => void handleStage()}
            >
              {staging ? "Staging..." : "Stage File"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
