// Inbound Webhooks view (Phase 5 Row 24).
// Replaces the #viewWebhooks stub with the webhook grid, delivery feed and create modal.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, Webhook, WebhookDelivery } from "../data";
import {
  CURL_COPIED_MESSAGE,
  DELIVERY_EMPTY_STATE,
  WEBHOOK_EMPTY_STATE,
  WEBHOOK_VALIDATION_MESSAGE,
  closeCreateWebhookModal,
  createInitialModalState,
  curlCommand,
  deliveryView,
  openCreateWebhookModal,
  validateCreateWebhookInput,
  webhookCardView,
} from "../../../src/shell/webhooks-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface WebhooksViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function WebhooksView({ data, active, onSelect, refreshKey }: WebhooksViewProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);
  const [copied, setCopied] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState("routine");
  const [targetId, setTargetId] = useState("");
  const [secret, setSecret] = useState("");
  const [filterEvent, setFilterEvent] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [hooks, feed] = await Promise.all([data.getWebhooks(), data.getWebhookDeliveries()]);
        if (cancelled) return;
        setWebhooks(Array.isArray(hooks) ? hooks : []);
        setDeliveries(Array.isArray(feed) ? feed : []);
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
      setModals((state) => closeCreateWebhookModal(state));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reload = async () => {
    try {
      setLoading(true);
      const [hooks, feed] = await Promise.all([data.getWebhooks(), data.getWebhookDeliveries()]);
      setWebhooks(Array.isArray(hooks) ? hooks : []);
      setDeliveries(Array.isArray(feed) ? feed : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCreate = () => {
    setName("");
    setTargetType("routine");
    setTargetId("");
    setSecret("");
    setFilterEvent("");
    setCreateError(null);
    setModals((state) => openCreateWebhookModal(state));
  };

  const handleCreate = async () => {
    const input = {
      name,
      targetType,
      targetId,
      secret: secret.trim() || undefined,
      filterEvent: filterEvent.trim() || undefined,
      enabled: true,
    };
    const validation = validateCreateWebhookInput(input);
    if (validation) {
      setCreateError(validation);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await data.createWebhook(input);
      setModals((state) => closeCreateWebhookModal(state));
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (webhook: Webhook) => {
    if (!window.confirm(`Delete webhook "${webhook.name}"?`)) return;
    try {
      await data.deleteWebhook(webhook.name);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(curlCommand(url));
      setCopied(CURL_COPIED_MESSAGE);
    } catch {
      setCopied("Could not copy to clipboard.");
    }
  };

  const group = NAV_GROUPS.find((nav) => nav.tabs.some((tab) => tab.view === "webhooks"));
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div id={viewPanelId("webhooks")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container webhooks-view-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "webhooks" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "webhooks" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">📥 Inbound Proactive Webhooks</div>
            <div class="dashboard-subtitle">
              Register HTTP triggers that start routines or agent turns, with optional HMAC secrets.
            </div>
          </div>
          <button id="btnRefreshWebhooks" type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>
            Refresh
          </button>
          <button id="btnOpenCreateWebhook" type="button" class="btn btn-primary" onClick={handleOpenCreate}>
            + New Webhook
          </button>
        </div>

        {loadError && (
          <div class="webhooks-error" role="alert">
            <span>Could not load webhooks: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}
        {copied && <div class="webhooks-copied" role="status">{copied}</div>}

        <div class="card-grid" id="webhooksCardGrid">
          {loading ? (
            <div class="webhooks-loading">Loading webhooks…</div>
          ) : webhooks.length === 0 ? (
            <div class="webhooks-empty">{WEBHOOK_EMPTY_STATE}</div>
          ) : (
            webhooks.map((webhook) => {
              const card = webhookCardView(webhook);
              const url = `${origin}${card.urlPath}`;
              return (
                <div class="dashboard-card" key={webhook.name}>
                  <div class="card-top">
                    <div class="card-title">{card.title}</div>
                    <span class="badge badge-success">{card.triggersLabel}</span>
                  </div>
                  <div class="card-desc"><strong>Target:</strong> {card.target}</div>
                  <div class="card-meta">
                    <span class="badge">Auth: {card.authLabel}</span>
                    {card.eventBadge && <span class="badge">Event: {card.eventBadge}</span>}
                  </div>
                  <div class="webhook-url-box">{url}</div>
                  <div class="card-footer webhook-footer">
                    <button type="button" class="btn btn-secondary btn-xs btn-copy-curl"
                      onClick={() => void handleCopy(url)}>Copy curl</button>
                    <button type="button" class="btn btn-ghost btn-xs btn-delete-webhook"
                      onClick={() => void handleDelete(webhook)}>Delete</button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <h3 class="webhooks-section-title">Deliveries</h3>
        <div class="webhooks-feed" id="webhooksDeliveriesFeed">
          {loading ? (
            <div class="webhooks-loading">Loading deliveries…</div>
          ) : deliveries.length === 0 ? (
            <div class="webhooks-empty">{DELIVERY_EMPTY_STATE}</div>
          ) : (
            deliveries.slice(-25).reverse().map((delivery, index) => {
              const view = deliveryView(delivery);
              return (
                <div class={view.className} key={`${view.time}-${index}`}>
                  <div class="webhook-header-row">
                    <div>
                      <span class={view.statusClass}>{view.status}</span>
                      <strong class="webhook-title">{view.title}</strong>
                      {view.durationLabel && <span class="webhook-duration">{view.durationLabel}</span>}
                    </div>
                    <span class="webhook-time">{view.time}</span>
                  </div>
                  {view.error && <div class="webhook-error-text">Error: {view.error}</div>}
                  {view.result && <pre class="webhook-result-box">{view.result}</pre>}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="createWebhookModal"
        class={`modal-overlay${modals.createWebhookModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createWebhookModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createWebhookModalTitle">Create Inbound Webhook</h3>
            <button
              id="btnCloseCreateWebhook"
              type="button"
              class="btn-close"
              aria-label="Close create webhook dialog"
              onClick={() => setModals((state) => closeCreateWebhookModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="webhookName">Slug name</label>
              <input type="text" id="webhookName" class="form-control" value={name}
                onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="webhookTargetType">Target type</label>
              <select id="webhookTargetType" class="form-control" value={targetType}
                onChange={(e) => setTargetType((e.currentTarget as HTMLSelectElement).value)}>
                <option value="routine">Routine</option>
                <option value="agent">Agent</option>
                <option value="session">Session</option>
              </select>
            </div>
            <div class="form-group">
              <label for="webhookTargetId">Target ID</label>
              <input type="text" id="webhookTargetId" class="form-control" value={targetId}
                onInput={(e) => setTargetId((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="webhookSecret">Signing secret (optional)</label>
              <input type="password" id="webhookSecret" class="form-control" value={secret}
                onInput={(e) => setSecret((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="webhookFilterEvent">Filter event (optional)</label>
              <input type="text" id="webhookFilterEvent" class="form-control" value={filterEvent}
                onInput={(e) => setFilterEvent((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div id="webhookFormError" class="webhooks-form-error" role={createError ? "alert" : undefined}>
              {createError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button id="btnSaveWebhook" type="button" class="btn btn-primary" disabled={creating}
              onClick={() => void handleCreate()}>
              {creating ? "Saving..." : "Save Webhook"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
