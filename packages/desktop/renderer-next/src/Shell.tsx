import { useEffect, useRef, useState } from "preact/hooks";
import type { ShellData, ToolApprovalRequest } from "./data";
import { ChatList } from "./views/ChatList";
import { RoomsView } from "./views/RoomsView";
import { MissionList } from "./views/MissionList";
import { MissionTimeline } from "./views/MissionTimeline";
import { MissionReceipt } from "./views/MissionReceipt";
import { Inbox, ApprovalDecisionButtons } from "./views/Inbox";
import { QuickCaptureButton, QuickCaptureOutput, useQuickCapture } from "./views/QuickCapture";
import { Chat, useChatTurn } from "./views/Chat";
import { Canvas } from "./views/Canvas";
import { Inspector } from "./views/Inspector";
import {
  closeCanvas,
  closeTab,
  createInitialCanvasState,
  openArtifact,
  selectTab,
  setViewMode,
  type ArtifactItem,
  type CanvasState,
} from "../../src/shell/canvas-model";
import {
  NAV_GROUPS,
  VIEW_IDS,
  VIEW_TITLES,
  groupForView,
  isFooterNavActive,
  parseViewFromLocation,
  viewHash,
  viewPanelId,
  type ViewId,
} from "../../src/shell/navigation-model";
import {
  classifyShortcut,
  nextSidebarCollapsed,
  persistSidebarCollapsed,
  persistTheme,
  readSidebarCollapsed,
  readTheme,
  resolveEscapeTarget,
  toggleTheme,
  type Theme,
} from "../../src/shell/account-model";
import { isChatBusy } from "../../src/shell/chat-turn-model";
import {
  authFailed,
  authStarted,
  authSucceeded,
  closeAuthModal,
  createInitialAuthState,
  isAuthSubmitKey,
  normalizeToken,
  openAuthModal,
  setAuthInput,
  validateToken,
  type AuthState,
} from "../../src/shell/auth-model";

export const SESSION_KEY = "opensand-session-id";

/** localStorage can be blocked (or absent in a non-browser render); fall back to no persistence. */
function shellStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sessionAuthStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface ShellProps {
  data: ShellData;
}

function ViewPanel({
  view,
  active,
  onSelect,
}: {
  view: ViewId;
  active: boolean;
  onSelect: (view: ViewId) => void;
}) {
  const group = groupForView(view);
  return (
    <div id={viewPanelId(view)} class={`view-panel view-panel-stub ${active ? "" : "hidden"}`}>
      <div class="dashboard-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === view ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === view ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}
        <div class="view-stub-card">
          <h2 class="view-stub-title">{VIEW_TITLES[view]}</h2>
          <p class="view-stub-desc">
            This view is being rebuilt in the Preact shell. Navigation, subnav tabs and deep links are live.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Shell({ data }: ShellProps) {
  const [missionId, setMissionId] = useState<string | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<ToolApprovalRequest | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [approvalsRev, setApprovalsRev] = useState(0);
  const [canvasState, setCanvasState] = useState<CanvasState>(createInitialCanvasState());
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [currentView, setCurrentView] = useState<ViewId>(() =>
    parseViewFromLocation(window.location.search, window.location.hash)
  );
  const [theme, setTheme] = useState<Theme>(() => {
    let prefersDark = false;
    try {
      prefersDark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    } catch {}
    return readTheme(shellStorage(), prefersDark);
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed(shellStorage()));
  const [isAccountPopupOpen, setAccountPopupOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>(() => createInitialAuthState(sessionAuthStorage()));
  const [dataRev, setDataRev] = useState(0);

  const didRestoreRef = useRef(false);
  const authInputRef = useRef<HTMLInputElement>(null);

  const capture = useQuickCapture(data);
  // The chat turn lives at the shell level so opening an approval detail does not drop it.
  const chat = useChatTurn(data, selectedSessionId);

  // Restore saved session from localStorage validated against live sessions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let savedId: string | null = null;
      try {
        savedId = localStorage.getItem(SESSION_KEY);
      } catch {}

      try {
        const live = await data.listSessions();
        if (cancelled) return;
        const list = Array.isArray(live) ? live : [];
        const titleMap: Record<string, string> = {};
        for (const s of list) {
          if (s.id && s.title) titleMap[s.id] = s.title;
        }
        setSessionTitles((prev) => ({ ...prev, ...titleMap }));

        if (savedId) {
          const matching = list.find((s) => s.id === savedId);
          if (matching) {
            setSelectedSessionId(matching.id);
          } else {
            try {
              localStorage.removeItem(SESSION_KEY);
            } catch {}
          }
        }
      } catch {
        if (savedId) {
          try {
            localStorage.removeItem(SESSION_KEY);
          } catch {}
        }
      } finally {
        didRestoreRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  // Persist selectedSessionId to localStorage across updates
  useEffect(() => {
    if (!didRestoreRef.current) return;
    try {
      if (selectedSessionId) {
        localStorage.setItem(SESSION_KEY, selectedSessionId);
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch {}
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId || !data.loadSession) {
      setActiveAgentId(null);
      return;
    }
    let cancelled = false;
    data
      .loadSession(selectedSessionId)
      .then((res) => {
        if (cancelled || !res) return;
        if (res.agentId) {
          setActiveAgentId(res.agentId);
        }
        if (res.title) {
          setSessionTitles((prev) => ({ ...prev, [selectedSessionId]: res.title }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, data]);

  // Theme and sidebar state are mirrored to the document/localStorage so the shell keeps
  // the legacy keys and looks identical after a reload.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    persistTheme(shellStorage(), theme);
  }, [theme]);

  useEffect(() => {
    persistSidebarCollapsed(shellStorage(), sidebarCollapsed);
  }, [sidebarCollapsed]);

  // Global shortcuts: Cmd/Ctrl+B sidebar, +I details, +Shift+A canvas, Esc closes the topmost layer.
  // The listener is installed once; a render-time ref keeps the Esc precedence in sync even when
  // effect callbacks are deferred by the renderer.
  const shortcutStateRef = useRef({
    accountPopupOpen: false,
    canvasOpen: false,
    detailOpen: false,
    turnBusy: false,
    sidebarCollapsed: false,
  });
  shortcutStateRef.current = {
    accountPopupOpen: isAccountPopupOpen,
    canvasOpen: canvasState.isOpen,
    detailOpen: isDetailOpen,
    turnBusy: isChatBusy(chat.state.status),
    sidebarCollapsed,
  };
  const stopTurnRef = useRef(chat.stop);
  stopTurnRef.current = chat.stop;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = classifyShortcut(e);
      if (!action) return;
      if (action === "escape") {
        const target = resolveEscapeTarget({
          ...shortcutStateRef.current,
          isFullscreen: Boolean(document.fullscreenElement),
        });
        if (target === "none") return;
        e.preventDefault();
        if (target === "account-popup") setAccountPopupOpen(false);
        else if (target === "exit-fullscreen") void document.exitFullscreen?.();
        else if (target === "canvas") setCanvasState((prev) => closeCanvas(prev));
        else if (target === "detail") setIsDetailOpen(false);
        else stopTurnRef.current();
        return;
      }
      e.preventDefault();
      if (action === "toggle-sidebar") {
        const next = nextSidebarCollapsed(shortcutStateRef.current.sidebarCollapsed);
        setSidebarCollapsed(next);
        persistSidebarCollapsed(shellStorage(), next);
      } else if (action === "toggle-detail") setIsDetailOpen((prev) => !prev);
      else setCanvasState((prev) => ({ ...prev, isOpen: !prev.isOpen }));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Deep links: `?view=...` on first load, then #hash and back/forward navigation.
  useEffect(() => {
    const applyLocation = () => {
      setCurrentView(parseViewFromLocation(window.location.search, window.location.hash));
    };
    window.addEventListener("hashchange", applyLocation);
    window.addEventListener("popstate", applyLocation);
    return () => {
      window.removeEventListener("hashchange", applyLocation);
      window.removeEventListener("popstate", applyLocation);
    };
  }, []);

  // A 401 from the server (or an auth_required bridge event) opens the token modal.
  useEffect(() => {
    if (!data.onAuthRequired) return;
    return data.onAuthRequired(() => setAuthState((prev) => openAuthModal(prev)));
  }, [data]);

  useEffect(() => {
    if (authState.isOpen) authInputRef.current?.focus();
  }, [authState.isOpen]);

  const handleAuthSubmit = async () => {
    const error = validateToken(authState.input);
    if (error) {
      setAuthState((prev) => authFailed(prev, error));
      return;
    }
    const token = normalizeToken(authState.input);
    setAuthState((prev) => authStarted(prev));
    try {
      await data.authenticate(token);
      setAuthState((prev) => authSucceeded(prev, token, sessionAuthStorage()));
      setDataRev((n) => n + 1);
      setApprovalsRev((n) => n + 1);
    } catch (err) {
      setAuthState((prev) => authFailed(prev, err instanceof Error ? err.message : String(err)));
    }
  };

  const switchView = (view: ViewId) => {
    setCurrentView(view);
    const hash = viewHash(view);
    if (window.location.hash !== hash) window.location.hash = hash;
  };

  const handleToggleTheme = () => {
    const next = toggleTheme(theme);
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    persistTheme(shellStorage(), next);
  };
  const handleToggleSidebar = (force?: boolean) => {
    const next = nextSidebarCollapsed(sidebarCollapsed, force);
    setSidebarCollapsed(next);
    persistSidebarCollapsed(shellStorage(), next);
  };

  const handleAccountAction = (action: "sentinel" | "settings" | "theme" | "clear") => {
    setAccountPopupOpen(false);
    if (action === "sentinel" || action === "settings") {
      switchView(action);
    } else if (action === "theme") {
      handleToggleTheme();
    } else {
      void (async () => {
        try {
          await data.clearAllSessions?.();
        } catch {}
        setSelectedSessionId(null);
        try {
          localStorage.removeItem(SESSION_KEY);
        } catch {}
      })();
    }
  };

  const handleSelectMission = (id: string) => {
    switchView("chat");
    setSelectedApproval(null);
    setMissionId(id);
  };

  const handleSelectApproval = (appr: ToolApprovalRequest) => {
    switchView("chat");
    setSelectedApproval(appr);
  };

  const handleSelectSession = (id: string, title?: string) => {
    switchView("chat");
    setMissionId(null);
    setSelectedApproval(null);
    setSelectedSessionId(id);
    if (title) {
      setSessionTitles((prev) => ({ ...prev, [id]: title }));
    }
  };

  const handleOpenArtifact = (art: Partial<ArtifactItem> & { title: string; content: string }) => {
    setCanvasState((prev) => openArtifact(prev, art));
  };

  const handleSelectTab = (id: string) => {
    setCanvasState((prev) => selectTab(prev, id));
  };

  const handleCloseTab = (id: string) => {
    setCanvasState((prev) => closeTab(prev, id));
  };

  const handleCloseCanvas = () => {
    setCanvasState((prev) => closeCanvas(prev));
  };

  const handleSetViewMode = (id: string, mode: "code" | "preview" | "diff") => {
    setCanvasState((prev) => setViewMode(prev, id, mode));
  };

  const hasCanvasOpen = canvasState.isOpen && canvasState.artifacts.length > 0;
  const activeSessionTitle = selectedSessionId
    ? (sessionTitles[selectedSessionId] || selectedSessionId)
    : "New Session";

  return (
    <div class="app-layout">
      {isAccountPopupOpen && (
        <div class="account-popup-backdrop" aria-hidden="true" onClick={() => setAccountPopupOpen(false)} />
      )}
      <aside class={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <div class="sidebar-header">
          <div
            class="brand"
            id="brandHomeBtn"
            role="button"
            tabIndex={0}
            title="OpenSand Home"
            onClick={() => {
              switchView("chat");
              setMissionId(null);
              setSelectedApproval(null);
              setSelectedSessionId(null);
              try {
                localStorage.removeItem(SESSION_KEY);
              } catch {}
            }}
          >
            <div class="brand-avatar">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" />
              </svg>
            </div>
            <div class="brand-info">
              <span class="brand-title">OpenSand</span>
              <span class="status-indicator">Ready</span>
            </div>
          </div>
          <div class="sidebar-header-actions">
            <button
              id="btnCollapseSidebar"
              type="button"
              class="btn-icon-ghost"
              aria-label="Collapse sidebar"
              title="Collapse Sidebar (Cmd+B)"
              onClick={() => handleToggleSidebar(true)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
          </div>
        </div>
        <div id="inboxSection" class="inbox-section">
          <Inbox
            data={data}
            onSelectApproval={handleSelectApproval}
            refreshKey={approvalsRev}
            onDecided={() => {
              setSelectedApproval(null);
              setApprovalsRev((n) => n + 1);
            }}
          />
        </div>
        <div id="missionList" class="mission-list-section">
          <MissionList key={dataRev} data={data} onSelect={handleSelectMission} />
        </div>
        <div id="sessionList" class="session-list" role="list" aria-label="Sessions">
          <ChatList
            key={dataRev}
            data={data}
            selectedSessionId={selectedSessionId}
            onSelectSession={handleSelectSession}
            onDeleteSession={(deletedId) => {
              if (selectedSessionId === deletedId) {
                setSelectedSessionId(null);
                try {
                  localStorage.removeItem(SESSION_KEY);
                } catch {}
              }
            }}
          />
        </div>
        <div class="sidebar-footer">
          <nav class="sidebar-footer-nav" aria-label="Primary destinations">
            {NAV_GROUPS.map((group) => {
              const active = isFooterNavActive(currentView, group.id);
              return (
                <button
                  key={group.id}
                  id={group.buttonId}
                  type="button"
                  class={`footer-nav-btn ${active ? "active" : ""}`}
                  data-view={group.view}
                  title={group.buttonLabel}
                  aria-current={active ? "page" : undefined}
                  onClick={() => switchView(group.view)}
                >
                  <span class="footer-nav-label">{group.buttonLabel}</span>
                </button>
              );
            })}
          </nav>
          <div class="sidebar-account-box">
            <button
              id="accountMenuTrigger"
              type="button"
              class="account-btn"
              aria-haspopup="true"
              aria-expanded={isAccountPopupOpen}
              title="Account & Preferences"
              onClick={(e) => {
                e.stopPropagation();
                setAccountPopupOpen((prev) => !prev);
              }}
            >
              <div class="user-avatar-initials" id="userAvatarInitials">P</div>
              <span class="account-name" id="userAccountName">Phil</span>
              <span class="account-dots">⋯</span>
            </button>
            <div id="accountPopup" class={`account-popup${isAccountPopupOpen ? "" : " hidden"}`}>
              <button id="btnMenuSentinel" type="button" class="account-popup-item" onClick={() => handleAccountAction("sentinel")}>
                <span class="popup-icon" aria-hidden="true">🛡️</span><span>Admin / Sentinel</span>
              </button>
              <button id="btnMenuSettings" type="button" class="account-popup-item" onClick={() => handleAccountAction("settings")}>
                <span class="popup-icon" aria-hidden="true">⚙️</span><span>Settings</span>
              </button>
              <button id="btnMenuToggleTheme" type="button" class="account-popup-item" onClick={() => handleAccountAction("theme")}>
                <span class="popup-icon" aria-hidden="true">🌙</span><span>Toggle Theme</span>
              </button>
              <div class="popup-divider"></div>
              <button id="btnMenuClearSessions" type="button" class="account-popup-item danger" onClick={() => handleAccountAction("clear")}>
                <span class="popup-icon" aria-hidden="true">🗑️</span><span>Clear History</span>
              </button>
            </div>
          </div>
          <button id="btnSettings" type="button" class="hidden" aria-hidden="true" tabIndex={-1} />
          <span class="shell-note">Preact shell (preview)</span>
        </div>
      </aside>
      <main class="main-panel">
        <header class="topbar">
          <div class="topbar-left">
            <button
              id="btnToggleSidebar"
              type="button"
              class={`btn-icon-ghost btn-toggle-sidebar${sidebarCollapsed ? " active" : ""}`}
              aria-label="Toggle sidebar"
              title={sidebarCollapsed ? "Expand Sidebar (Cmd+B)" : "Collapse Sidebar (Cmd+B)"}
              onClick={() => handleToggleSidebar()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
            {currentView !== "chat" && (
              <button
                id="btnBackToChat"
                type="button"
                class="btn btn-ghost btn-xs"
                title="Back to Dialogue"
                onClick={() => switchView("chat")}
              >
                ← Chat
              </button>
            )}
            <h1 class="view-header-title" id="viewHeaderTitle">{VIEW_TITLES[currentView]}</h1>
            <span class="active-session-title" id="activeSessionTitle" title={activeSessionTitle}>
              {activeSessionTitle}
            </span>
          </div>
          <div class="topbar-actions">
            {canvasState.artifacts.length > 0 && (
              <button
                id="btnToggleCanvas"
                type="button"
                class="btn btn-sm btn-ghost btn-toggle-canvas"
                title="Toggle Canvas"
                onClick={() =>
                  setCanvasState((prev) => ({
                    ...prev,
                    isOpen: !prev.isOpen,
                  }))
                }
              >
                Canvas ({canvasState.artifacts.length})
              </button>
            )}
            <QuickCaptureButton capture={capture} />
            <button
              id="btnToggleDetail"
              type="button"
              class={`btn btn-sm btn-ghost btn-toggle-detail ${isDetailOpen ? "active" : ""}`}
              title="Toggle Details (Cmd+I)"
              aria-label="Toggle Details"
              aria-expanded={isDetailOpen}
              onClick={() => setIsDetailOpen((prev) => !prev)}
            >
              ℹ️ Details
            </button>
          </div>
          <div class="topbar-status-group">
            <button
              id="btnToggleTheme"
              type="button"
              class="btn btn-icon-sm"
              title={theme === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme"}
              aria-label="Toggle light or dark theme"
              onClick={handleToggleTheme}
            >
              {theme === "dark" ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              )}
            </button>
          </div>
        </header>
        <QuickCaptureOutput capture={capture} />
        <section class="shell-body">
          <div id={viewPanelId("chat")} class={`view-panel view-panel-chat ${currentView === "chat" ? "" : "hidden"}`}>
            {selectedApproval ? (
            <div class="approval-detail-view" aria-label="Approval Details">
              <div class="approval-detail-card">
                <header class="approval-detail-header">
                  <div class="approval-header-main">
                    <span class="modal-alert-icon" aria-hidden="true">⚠️</span>
                    <h2>Authorization Required</h2>
                  </div>
                  <button
                    type="button"
                    class="btn-close-approval"
                    id="btnCloseApprovalDetail"
                    aria-label="Close approval details"
                    onClick={() => setSelectedApproval(null)}
                  >
                    ✕
                  </button>
                </header>
                <div class="approval-detail-body">
                  <div class="approval-row">
                    <strong>Tool:</strong> <span id="approvalDetailToolName">{selectedApproval.toolName}</span>
                  </div>
                  {selectedApproval.reason && (
                    <div class="approval-row">
                      <strong>Reason:</strong> <span id="approvalDetailReason">{selectedApproval.reason}</span>
                    </div>
                  )}
                  <div class="approval-row">
                    <strong>Arguments:</strong>
                  </div>
                  <pre class="approval-args-box" id="approvalDetailArgsBox">
                    {JSON.stringify(selectedApproval.args, null, 2)}
                  </pre>
                  <div class="approval-meta-row">
                    <span>Epoch: {selectedApproval.epoch}</span>
                    <span>ID: {selectedApproval.approvalId}</span>
                  </div>
                  <ApprovalDecisionButtons
                    data={data}
                    req={selectedApproval}
                    idPrefix="main"
                    onDecided={() => {
                      setSelectedApproval(null);
                      setApprovalsRev((n) => n + 1);
                    }}
                  />
                </div>
              </div>
            </div>
          ) : missionId ? (
            <div class="mission-main">
              <MissionTimeline data={data} missionId={missionId} onSelectMission={handleSelectMission} />
              <MissionReceipt data={data} missionId={missionId} />
            </div>
          ) : (
            <div class={`chat-canvas-split ${hasCanvasOpen ? "canvas-open" : "canvas-closed"}`} data-canvas-open={canvasState.isOpen}>
              <div class="chat-split-pane">
                <Chat
                  chat={chat}
                  selectedSessionId={selectedSessionId}
                  data={data}
                  onOpenArtifact={handleOpenArtifact}
                />
              </div>
              <div class="canvas-split-pane">
                <Canvas
                  state={canvasState}
                  onSelectTab={handleSelectTab}
                  onCloseTab={handleCloseTab}
                  onCloseCanvas={handleCloseCanvas}
                  onSetViewMode={handleSetViewMode}
                />
              </div>
            </div>
          )}
          </div>
          {VIEW_IDS.filter((view) => view !== "chat").map((view) =>
            view === "rooms" ? (
              <RoomsView
                key="rooms"
                data={data}
                active={currentView === "rooms"}
                onSelect={switchView}
                refreshKey={dataRev}
              />
            ) : (
              <ViewPanel key={view} view={view} active={currentView === view} onSelect={switchView} />
            )
          )}
        </section>
      </main>
      <Inspector
        isOpen={isDetailOpen}
        onClose={() => setIsDetailOpen(false)}
        data={data}
        activeAgentId={activeAgentId}
        currentSessionId={selectedSessionId}
        onClearSession={() => {
          setSelectedSessionId(null);
          try {
            localStorage.removeItem(SESSION_KEY);
          } catch {}
        }}
      />
      <div
        id="authModal"
        class={`modal-overlay${authState.isOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="authModalTitle"
      >
        <div class="modal-card auth-modal-card" style="max-width: 480px;">
          <div class="modal-header">
            <span class="modal-alert-icon" aria-hidden="true">🔐</span>
            <h3 id="authModalTitle">Authentication Required</h3>
          </div>
          <div class="modal-body">
            <p class="auth-modal-copy">
              The OpenSand server requires a session authentication token. Copy your token from
              <code> ~/.opensand/server.token </code> or your terminal launch output.
            </p>
            <div class="form-group">
              <label for="serverAuthTokenInput">Server Authentication Token</label>
              <input
                ref={authInputRef}
                type="password"
                id="serverAuthTokenInput"
                class="form-control"
                placeholder="Paste 64-character token"
                autocomplete="off"
                value={authState.input}
                onInput={(e) => setAuthState((prev) => setAuthInput(prev, (e.currentTarget as HTMLInputElement).value))}
                onKeyDown={(e) => {
                  if (!isAuthSubmitKey(e)) return;
                  e.preventDefault();
                  void handleAuthSubmit();
                }}
              />
              <div
                id="authErrorMsg"
                class="auth-error-msg"
                style={{ color: "var(--danger)", fontSize: "12px", marginTop: "6px", display: authState.error ? "block" : "none" }}
                role={authState.error ? "alert" : undefined}
              >
                {authState.error ?? ""}
              </div>
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSubmitAuthToken"
              type="button"
              class="btn btn-primary"
              style="width: 100%;"
              disabled={authState.status === "submitting"}
              onClick={() => void handleAuthSubmit()}
            >
              {authState.status === "submitting" ? "Authenticating..." : "Connect & Authenticate"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
