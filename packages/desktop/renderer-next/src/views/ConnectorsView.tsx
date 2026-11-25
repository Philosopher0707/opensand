// 3rd-Party OAuth Connectors view (Phase 5 Row 25).
// Replaces the #viewConnectors stub with connector cards, OAuth/token flows and configure modal.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ShellData, Connector } from "../data";
import {
  CONNECTORS_EMPTY_STATE,
  CONNECTORS_LOAD_ERROR,
  TOKEN_VALIDATION_MESSAGE,
  closeConfigureConnectorModal,
  connectorCardView,
  connectorTestMessage,
  createInitialModalState,
  openConfigureConnectorModal,
  tokenHint,
} from "../../../src/shell/connectors-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface ConnectorsViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const POLL_MS = 1500;
const POLL_LIMIT_MS = 60_000;

export function ConnectorsView({ data, active, onSelect, refreshKey }: ConnectorsViewProps) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [modalId, setModalId] = useState("");
  const [modalName, setModalName] = useState("");
  const [account, setAccount] = useState("");
  const [token, setToken] = useState("");
  const [configureError, setConfigureError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pollRef = useRef<{ interval?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await data.getConnectors();
        if (cancelled) return;
        setConnectors(Array.isArray(list) ? list : []);
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
    const timers = pollRef.current;
    return () => {
      if (timers.interval) clearInterval(timers.interval);
      if (timers.timeout) clearTimeout(timers.timeout);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      setModals((state) => closeConfigureConnectorModal(state));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reload = async () => {
    try {
      setLoading(true);
      const list = await data.getConnectors();
      setConnectors(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const stopPolling = () => {
    if (pollRef.current.interval) clearInterval(pollRef.current.interval);
    if (pollRef.current.timeout) clearTimeout(pollRef.current.timeout);
    pollRef.current = {};
  };

  const handleConnect = async (connector: Connector) => {
    if (busyId) return;
    setBusyId(connector.id);
    setNotice(null);
    try {
      const flow = await data.connectApp(connector.id);
      if (flow?.authUrl && typeof window !== "undefined") {
        window.open(flow.authUrl, "_blank", "noopener,noreferrer");
        stopPolling();
        pollRef.current.interval = setInterval(async () => {
          try {
            const updated = await data.getConnector(connector.id);
            if (updated?.status === "connected") {
              stopPolling();
              await reload();
            }
          } catch {
            // Keep polling: a transient lookup failure is not a disconnect.
          }
        }, POLL_MS);
        pollRef.current.timeout = setTimeout(stopPolling, POLL_LIMIT_MS);
      } else {
        await reload();
      }
    } catch (err) {
      setNotice(`Could not start OAuth for ${connector.name || connector.id}: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenConfigure = (connector: Connector) => {
    setModalId(connector.id);
    setModalName(connector.name || connector.id);
    setAccount(connector.account || "");
    setToken("");
    setConfigureError(null);
    setModals((state) => openConfigureConnectorModal(state));
  };

  const handleSave = async () => {
    if (!token.trim()) {
      setConfigureError(TOKEN_VALIDATION_MESSAGE);
      return;
    }
    setSaving(true);
    setConfigureError(null);
    try {
      await data.connectApp(modalId, { token: token.trim(), account: account.trim() || undefined });
      setToken("");
      setModals((state) => closeConfigureConnectorModal(state));
      await reload();
    } catch (err) {
      setConfigureError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (connector: Connector) => {
    if (busyId) return;
    setBusyId(connector.id);
    setNotice(null);
    try {
      setNotice(connectorTestMessage(await data.testConnector(connector.id)));
    } catch (err) {
      setNotice(`Test failed: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (connector: Connector) => {
    if (!window.confirm(`Disconnect ${connector.name}? Agents will no longer be able to access this service.`)) return;
    try {
      await data.disconnectApp(connector.id);
      await reload();
    } catch (err) {
      setNotice(`Could not disconnect ${connector.name}: ${errorMessage(err)}`);
    }
  };

  const group = NAV_GROUPS.find((nav) => nav.tabs.some((tab) => tab.view === "connectors"));

  return (
    <div id={viewPanelId("connectors")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container connectors-view-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "connectors" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "connectors" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">🔗 3rd-Party App OAuth Connectors</div>
            <div class="dashboard-subtitle">Authorize Slack, Linear, GitHub and other services for your agents.</div>
          </div>
          <button id="btnRefreshConnectors" type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>
            Refresh
          </button>
        </div>

        {loadError && (
          <div class="connectors-error" role="alert">
            <span>{CONNECTORS_LOAD_ERROR}: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}
        {notice && <div class="connectors-notice" role="status">{notice}</div>}

        <div class="card-grid connector-grid" id="connectorsCardGrid">
          {loading ? (
            <div class="connectors-loading">Loading connectors…</div>
          ) : connectors.length === 0 ? (
            <div class="connectors-empty">{CONNECTORS_EMPTY_STATE}</div>
          ) : (
            connectors.map((connector) => {
              const card = connectorCardView(connector);
              return (
                <div class="connector-dashboard-card" key={connector.id}>
                  <div class="connect-card-header">
                    <div class="connect-card-icon" style={{ backgroundColor: card.color }}>{card.icon}</div>
                    <div class="connect-card-meta">
                      <div class="connect-card-title">{card.title}</div>
                      <div class="connect-card-subtitle">{card.subtitle}</div>
                    </div>
                    <span class={`connect-card-badge ${card.statusClass}`}>{card.statusLabel}</span>
                  </div>
                  <div class="connector-account">{card.accountLine}</div>
                  <div class="connector-scopes-list">
                    {card.scopes.map((scope, index) => <span class="connector-scope-pill" key={`${scope}-${index}`}>{scope}</span>)}
                  </div>
                  <div class="card-footer connector-actions">
                    {!card.connected ? (
                      <>
                        <button type="button" class="btn btn-primary btn-sm btn-dash-oauth"
                          disabled={busyId !== null}
                          onClick={() => void handleConnect(connector)}>
                          {busyId === connector.id ? "Opening…" : "Connect via OAuth"}
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm btn-dash-config-token"
                          onClick={() => handleOpenConfigure(connector)}>
                          Enter Token
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" class="btn btn-secondary btn-sm btn-dash-test"
                          disabled={busyId !== null}
                          onClick={() => void handleTest(connector)}>
                          {busyId === connector.id ? "Testing…" : "Test Connection"}
                        </button>
                        <button type="button" class="btn btn-secondary btn-sm btn-dash-config-token"
                          onClick={() => handleOpenConfigure(connector)}>
                          Update Credential
                        </button>
                        <button type="button" class="btn btn-ghost btn-sm btn-dash-disconnect"
                          onClick={() => void handleDisconnect(connector)}>
                          Disconnect
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="configureConnectorModal"
        class={`modal-overlay${modals.configureConnectorModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="configureConnectorModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="configureConnectorModalTitle">Configure {modalName} Integration</h3>
            <button id="btnCloseConfigureConnector" type="button" class="btn-close" aria-label="Close configure connector dialog"
              onClick={() => setModals((state) => closeConfigureConnectorModal(state))}>&times;</button>
          </div>
          <div class="modal-body">
            <input type="hidden" id="configureConnectorId" value={modalId} readOnly />
            <div class="form-group">
              <label for="configureConnectorAccount">Account (optional)</label>
              <input type="text" id="configureConnectorAccount" class="form-control" value={account}
                onInput={(e) => setAccount((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <div class="form-group">
              <label for="configureConnectorToken">Token or API key</label>
              <input type="password" id="configureConnectorToken" class="form-control" value={token}
                onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <p id="configureConnectorHint" class="connectors-hint">{tokenHint(modalId)}</p>
            <div id="connectorFormError" class="connectors-form-error" role={configureError ? "alert" : undefined}>
              {configureError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button id="btnCancelConfigureConnector" type="button" class="btn btn-ghost"
              onClick={() => setModals((state) => closeConfigureConnectorModal(state))}>Cancel</button>
            <button id="btnSaveConnectorConfig" type="button" class="btn btn-primary" disabled={saving}
              onClick={() => void handleSave()}>
              {saving ? "Saving…" : "Save & Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
