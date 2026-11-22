// Shell frame for the Preact renderer: sidebar + main area only. Views are
// ported in later slices. Class names and ids match renderer/index.html so the
// shared styles.css (traffic-light clearance, drag regions) applies unchanged.
import { useState } from "preact/hooks";
import type { ShellData, ToolApprovalRequest } from "./data";
import { ChatList } from "./views/ChatList";
import { MissionList } from "./views/MissionList";
import { MissionTimeline } from "./views/MissionTimeline";
import { MissionReceipt } from "./views/MissionReceipt";
import { Inbox } from "./views/Inbox";
import { ApprovalDecisionButtons } from "../../src/shell/inbox-component";
import { QuickCaptureButton, QuickCaptureOutput, useQuickCapture } from "./views/QuickCapture";
import { Chat, useChatTurn } from "./views/Chat";
import { Canvas } from "./views/Canvas";
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

export interface ShellProps {
  data: ShellData;
}

export function Shell({ data }: ShellProps) {
  const [missionId, setMissionId] = useState<string | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<ToolApprovalRequest | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [approvalsRev, setApprovalsRev] = useState(0);
  const [canvasState, setCanvasState] = useState<CanvasState>(createInitialCanvasState());

  const capture = useQuickCapture(data);
  // The chat turn lives at the shell level so opening an approval detail does not drop it.
  const chat = useChatTurn(data, selectedSessionId);

  const handleSelectMission = (id: string) => {
    setSelectedApproval(null);
    setMissionId(id);
  };

  const handleSelectApproval = (appr: ToolApprovalRequest) => {
    setSelectedApproval(appr);
  };

  const handleSelectSession = (id: string) => {
    setMissionId(null);
    setSelectedApproval(null);
    setSelectedSessionId(id);
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

  return (
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div
            class="brand"
            id="brandHomeBtn"
            role="button"
            tabIndex={0}
            title="OpenSand Home"
            onClick={() => {
              setMissionId(null);
              setSelectedApproval(null);
              setSelectedSessionId(null);
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
          <MissionList data={data} onSelect={handleSelectMission} />
        </div>
        <div id="sessionList" class="session-list" role="list" aria-label="Sessions">
          <ChatList
            data={data}
            selectedSessionId={selectedSessionId}
            onSelectSession={handleSelectSession}
          />
        </div>
        <div class="sidebar-footer">
          <span class="shell-note">Preact shell (preview)</span>
        </div>
      </aside>
      <main class="main-panel">
        <header class="topbar">
          <div class="topbar-left">
            <h1 class="view-header-title" id="viewHeaderTitle">Home</h1>
            <span class="active-session-title" id="activeSessionTitle">
              {selectedSessionId || "New Session"}
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
          </div>
        </header>
        <QuickCaptureOutput capture={capture} />
        <section class="shell-body">
          {selectedApproval ? (
            <div class="approval-detail-view" aria-label="Approval Details">
              <div class="approval-detail-card">
                <header class="approval-detail-header">
                  <span class="modal-alert-icon" aria-hidden="true">⚠️</span>
                  <h2>Authorization Required</h2>
                </header>
                <div class="approval-detail-body">
                  <div class="approval-row">
                    <strong>Tool:</strong> <span>{selectedApproval.toolName}</span>
                  </div>
                  {selectedApproval.reason && (
                    <div class="approval-row">
                      <strong>Reason:</strong> <span>{selectedApproval.reason}</span>
                    </div>
                  )}
                  <div class="approval-row">
                    <strong>Arguments:</strong>
                  </div>
                  <pre class="approval-args-box">
                    {JSON.stringify(selectedApproval.args, null, 2)}
                  </pre>
                  <div class="approval-meta-row">
                    <span>Epoch: {selectedApproval.epoch}</span>
                    <span>ID: {selectedApproval.approvalId}</span>
                  </div>
                  <ApprovalDecisionButtons
                    data={data}
                    req={selectedApproval}
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
            <div class={`chat-canvas-split ${hasCanvasOpen ? "canvas-open" : "canvas-closed"}`}>
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
        </section>
      </main>
    </div>
  );
}
