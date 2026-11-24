import test from "node:test";
import assert from "node:assert";
import {
  CONNECTORS_DEFAULT_COLOR,
  CONNECTORS_DEFAULT_HINT,
  CONNECTORS_EMPTY_STATE,
  CONNECTORS_LOAD_ERROR,
  TOKEN_VALIDATION_MESSAGE,
  closeConfigureConnectorModal,
  connectorCardView,
  connectorTestMessage,
  createInitialModalState,
  openConfigureConnectorModal,
  safeBrandColor,
  tokenHint,
} from "../src/shell/connectors-model.js";

test("connectors-model: brand colour is restricted to hex", () => {
  assert.strictEqual(safeBrandColor("#abc"), "#abc");
  assert.strictEqual(safeBrandColor("#3B82F6ff"), "#3B82F6ff");
  assert.strictEqual(safeBrandColor("red; background: url(x)"), CONNECTORS_DEFAULT_COLOR);
  assert.strictEqual(safeBrandColor(undefined), CONNECTORS_DEFAULT_COLOR);
});

test("connectors-model: provider hints and generic fallback", () => {
  assert.ok(tokenHint("slack").includes("xoxb-"));
  assert.ok(tokenHint("linear").includes("lin_api_"));
  assert.ok(tokenHint("github").includes("ghp_"));
  assert.strictEqual(tokenHint("other"), CONNECTORS_DEFAULT_HINT);
});

test("connectors-model: card view maps status, account and scopes", () => {
  const connected = connectorCardView({
    id: "slack", name: " Slack ", description: " Chat ", status: "connected",
    account: " team-1 ", connectedAt: 0, scopes: ["chat:read", "chat:write"], brandColor: "#4A154B",
  });
  assert.strictEqual(connected.title, "Slack");
  assert.strictEqual(connected.subtitle, "Chat");
  assert.strictEqual(connected.statusLabel, "Connected");
  assert.strictEqual(connected.statusClass, "badge-connected");
  assert.strictEqual(connected.color, "#4A154B");
  assert.strictEqual(connected.connected, true);
  assert.strictEqual(connecting(connectorCardView({ id: "g", status: "connecting" })), true);
  assert.ok(connected.accountLine.includes("team-1"));
  assert.deepStrictEqual(connected.scopes, ["chat:read", "chat:write"]);

  const offline = connectorCardView({ id: "github" });
  assert.strictEqual(offline.statusLabel, "Disconnected");
  assert.strictEqual(offline.statusClass, "badge-disconnected");
  assert.strictEqual(offline.accountLine, "Not connected");
  assert.strictEqual(offline.icon, "🔌");
  assert.deepStrictEqual(offline.scopes, []);
});

function connecting(view: { connecting: boolean }): boolean {
  return view.connecting;
}

test("connectors-model: test result copy and modal helpers", () => {
  assert.strictEqual(connectorTestMessage({ ok: true }), "Connection verified!");
  assert.strictEqual(connectorTestMessage({ ok: false }), "Connection check failed.");
  assert.strictEqual(connectorTestMessage({ message: "pong" }), "pong");
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { configureConnectorModalOpen: false });
  const opened = openConfigureConnectorModal(initial);
  assert.deepStrictEqual(opened, { configureConnectorModalOpen: true });
  assert.deepStrictEqual(closeConfigureConnectorModal(opened), initial);
  assert.ok(TOKEN_VALIDATION_MESSAGE.includes("token"));
  assert.ok(CONNECTORS_EMPTY_STATE.includes("No connectors"));
  assert.ok(CONNECTORS_LOAD_ERROR.includes("load connectors"));
});
