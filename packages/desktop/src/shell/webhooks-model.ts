// Pure model for the Inbound Webhooks view (Phase 5 Row 24).
// Mirrors the legacy renderer/app.js webhook controller without DOM or bridge code.

export interface Webhook {
  name: string;
  targetType?: string;
  targetId?: string;
  triggerCount?: number;
  hasSecret?: boolean;
  filterEvent?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface WebhookDelivery {
  status?: string;
  webhookName?: string;
  durationMs?: number;
  timestamp?: number;
  error?: string;
  result?: unknown;
  [key: string]: unknown;
}

export interface CreateWebhookInput {
  name: string;
  targetType: string;
  targetId: string;
  secret?: string;
  filterEvent?: string;
  enabled: boolean;
}

export interface WebhookCardView {
  title: string;
  triggersLabel: string;
  target: string;
  authLabel: string;
  eventBadge: string;
  urlPath: string;
}

export interface DeliveryView {
  className: string;
  statusClass: string;
  status: string;
  title: string;
  durationLabel: string;
  time: string;
  error: string;
  result: string;
}

export interface WebhooksModalState {
  createWebhookModalOpen: boolean;
}

export const WEBHOOK_VALIDATION_MESSAGE = "Please specify webhook slug name and target ID.";
export const WEBHOOK_EMPTY_STATE = 'No inbound webhooks configured. Click "+ New Webhook" to register an HTTP trigger.';
export const DELIVERY_EMPTY_STATE =
  "No webhook deliveries received yet. Post HTTP requests to your webhook URLs to trigger actions.";
export const CURL_COPIED_MESSAGE = "Webhook cURL copied to clipboard.";

export function validateCreateWebhookInput(input: CreateWebhookInput): string | null {
  return input.name?.trim() && input.targetId?.trim() ? null : WEBHOOK_VALIDATION_MESSAGE;
}

/** The legacy path uses the slug name only; `origin` is supplied by the view. */
export function webhookUrlPath(name: string): string {
  return `/api/webhooks/${encodeURIComponent(name)}`;
}

export function curlCommand(url: string): string {
  return `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"event":"trigger","data":{"action":"run"}}'`;
}

export function webhookCardView(webhook: Webhook): WebhookCardView {
  return {
    title: webhook.name?.trim() || "Untitled webhook",
    triggersLabel: `Triggers: ${webhook.triggerCount || 0}`,
    target: `${(webhook.targetType || "routine").toUpperCase()} ➔ ${webhook.targetId || ""}`,
    authLabel: webhook.hasSecret ? "HMAC-SHA256" : "Open",
    eventBadge: webhook.filterEvent?.trim() || "",
    urlPath: webhookUrlPath(webhook.name?.trim() || ""),
  };
}

export function deliveryView(delivery: WebhookDelivery): DeliveryView {
  const status = delivery.status || "unknown";
  const isSuccess = status === "success";
  const result = delivery.result
    ? typeof delivery.result === "object"
      ? JSON.stringify(delivery.result, null, 2)
      : String(delivery.result)
    : "";
  return {
    className: `webhook-item ${isSuccess ? "clean" : "fail"}`,
    statusClass: `status-badge ${isSuccess ? "clean" : "fail"}`,
    status: status.toUpperCase(),
    title: `Webhook: ${delivery.webhookName || "unknown"}`,
    durationLabel: delivery.durationMs !== undefined ? `(${delivery.durationMs}ms)` : "",
    time: new Date(delivery.timestamp || Date.now()).toLocaleTimeString(),
    error: delivery.error || "",
    result,
  };
}

export function createInitialModalState(): WebhooksModalState {
  return { createWebhookModalOpen: false };
}

export function openCreateWebhookModal(state: WebhooksModalState): WebhooksModalState {
  return { ...state, createWebhookModalOpen: true };
}

export function closeCreateWebhookModal(state: WebhooksModalState): WebhooksModalState {
  return { ...state, createWebhookModalOpen: false };
}
