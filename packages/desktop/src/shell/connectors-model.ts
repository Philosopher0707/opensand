// Pure model for the 3rd-Party OAuth Connectors view (Phase 5 Row 25).
// Mirrors the legacy renderer/app.js connector controller without DOM or bridge code.

export type ConnectorStatus = "connected" | "connecting" | "disconnected" | string;

export interface Connector {
  id: string;
  name?: string;
  description?: string;
  status?: ConnectorStatus;
  icon?: string;
  brandColor?: string;
  account?: string;
  connectedAt?: number;
  scopes?: string[];
  [key: string]: unknown;
}

export interface ConnectorTestResult {
  ok?: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface ConnectorCardView {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  statusLabel: string;
  statusClass: string;
  accountLine: string;
  scopes: string[];
  connected: boolean;
  connecting: boolean;
}

export interface ConnectorsModalState {
  configureConnectorModalOpen: boolean;
}

export const CONNECTORS_EMPTY_STATE = "No connectors available.";
export const CONNECTORS_LOAD_ERROR = "Could not load connectors";
export const TOKEN_VALIDATION_MESSAGE = "Please enter a token or API key.";
export const CONNECTORS_DEFAULT_HINT = "Your credentials are encrypted locally on disk and never logged.";
export const CONNECTORS_DEFAULT_COLOR = "#3b82f6";

/** Only accept hex colours for the inline icon background; everything else falls back. */
export function safeBrandColor(raw?: string): string {
  return raw && /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : CONNECTORS_DEFAULT_COLOR;
}

export function tokenHint(id: string): string {
  if (id === "slack") return "Enter Slack Bot User OAuth Token (starts with xoxb-) or User Token (xoxp-).";
  if (id === "linear") return "Enter Linear Personal API Key (starts with lin_api_).";
  if (id === "github") return "Enter GitHub Personal Access Token (ghp_) or GitHub App Installation Token.";
  return CONNECTORS_DEFAULT_HINT;
}

export function connectorCardView(connector: Connector): ConnectorCardView {
  const connected = connector.status === "connected";
  const connecting = connector.status === "connecting";
  return {
    id: connector.id,
    title: connector.name?.trim() || connector.id,
    subtitle: connector.description?.trim() || "",
    icon: connector.icon?.trim() || "🔌",
    color: safeBrandColor(connector.brandColor),
    statusLabel: connected ? "Connected" : connecting ? "Connecting…" : "Disconnected",
    statusClass: connected ? "badge-connected" : connecting ? "badge-pending" : "badge-disconnected",
    accountLine: connected
      ? `Account: ${connector.account?.trim() || "Authorized"} • Connected ${new Date(connector.connectedAt || Date.now()).toLocaleDateString()}`
      : "Not connected",
    scopes: Array.isArray(connector.scopes) ? connector.scopes : [],
    connected,
    connecting,
  };
}

export function connectorTestMessage(result: ConnectorTestResult): string {
  return result.message || (result.ok ? "Connection verified!" : "Connection check failed.");
}

export function createInitialModalState(): ConnectorsModalState {
  return { configureConnectorModalOpen: false };
}

export function openConfigureConnectorModal(state: ConnectorsModalState): ConnectorsModalState {
  return { ...state, configureConnectorModalOpen: true };
}

export function closeConfigureConnectorModal(state: ConnectorsModalState): ConnectorsModalState {
  return { ...state, configureConnectorModalOpen: false };
}
