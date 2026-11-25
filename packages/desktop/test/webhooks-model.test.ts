import test from "node:test";
import assert from "node:assert";
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
  webhookUrlPath,
  type CreateWebhookInput,
} from "../src/shell/webhooks-model.js";

const valid: CreateWebhookInput = { name: "nightly", targetType: "routine", targetId: "r-1", enabled: true };

test("webhooks-model: validation requires name and target id", () => {
  assert.strictEqual(validateCreateWebhookInput(valid), null);
  assert.strictEqual(validateCreateWebhookInput({ ...valid, name: "" }), WEBHOOK_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateWebhookInput({ ...valid, targetId: "  " }), WEBHOOK_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateWebhookInput({ ...valid, name: " n ", targetId: " t " }), null);
});

test("webhooks-model: URL and curl command are built from the slug", () => {
  assert.strictEqual(webhookUrlPath("my hook"), "/api/webhooks/my%20hook");
  const curl = curlCommand("http://localhost/api/webhooks/nightly");
  assert.ok(curl.includes('curl -X POST "http://localhost/api/webhooks/nightly"'));
  assert.ok(curl.includes('"event":"trigger"'));
});

test("webhooks-model: card shows target, auth and no secret", () => {
  const card = webhookCardView({ name: " nightly ", triggerCount: 4, hasSecret: true, filterEvent: "push", targetId: "r-1" });
  assert.deepStrictEqual(card, {
    title: "nightly",
    triggersLabel: "Triggers: 4",
    target: "ROUTINE ➔ r-1",
    authLabel: "HMAC-SHA256",
    eventBadge: "push",
    urlPath: "/api/webhooks/nightly",
  });
  const plain = webhookCardView({ name: "open" });
  assert.strictEqual(plain.authLabel, "Open");
  assert.strictEqual(plain.eventBadge, "");
  assert.strictEqual(plain.triggersLabel, "Triggers: 0");
});

test("webhooks-model: deliveries map status to tone and stringify result", () => {
  const ok = deliveryView({ status: "success", webhookName: "nightly", durationMs: 12,
    result: { queued: true }, timestamp: 0 });
  assert.strictEqual(ok.className, "webhook-item clean");
  assert.strictEqual(ok.statusClass, "status-badge clean");
  assert.strictEqual(ok.status, "SUCCESS");
  assert.strictEqual(ok.title, "Webhook: nightly");
  assert.strictEqual(ok.durationLabel, "(12ms)");
  assert.ok(ok.result.includes('"queued": true'));

  const bad = deliveryView({ status: "failed", error: "bad signature", result: "nope", timestamp: 1000 });
  assert.strictEqual(bad.className, "webhook-item fail");
  assert.strictEqual(bad.error, "bad signature");
  assert.strictEqual(bad.result, "nope");
  assert.strictEqual(bad.durationLabel, "");
});

test("webhooks-model: modal helpers and copy constants", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { createWebhookModalOpen: false });
  const opened = openCreateWebhookModal(initial);
  assert.deepStrictEqual(opened, { createWebhookModalOpen: true });
  assert.deepStrictEqual(closeCreateWebhookModal(opened), initial);
  assert.ok(WEBHOOK_EMPTY_STATE.includes("+ New Webhook"));
  assert.ok(DELIVERY_EMPTY_STATE.includes("No webhook deliveries"));
  assert.ok(CURL_COPIED_MESSAGE.includes("copied"));
});
