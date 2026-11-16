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

export interface ShellProps {
  data: ShellData;
}

export function Shell({ data }: ShellProps) {
  const [missionId, setMissionId] = useState<string | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<ToolApprovalRequest | null>(null);

  const handleSelectMission = (id: string) => {
    setSelectedApproval(null);
    setMissionId(id);
  };

  const handleSelectApproval = (appr: ToolApprovalRequest) => {
    setSelectedApproval(appr);
  };

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
          <Inbox data={data} onSelectApproval={handleSelectApproval} />
        </div>
        <div id="missionList" class="mission-list-section">
          <MissionList data={data} onSelect={handleSelectMission} />
        </div>
        <div id="sessionList" class="session-list" role="list" aria-label="Sessions">
          <ChatList data={data} />
        </div>
        <div class="sidebar-footer">
          <span class="shell-note">Preact shell (preview)</span>
        </div>
      </aside>
      <main class="main-panel">
        <header class="topbar">
          <div class="topbar-left">
            <h1 class="view-header-title" id="viewHeaderTitle">Home</h1>
            <span class="active-session-title" id="activeSessionTitle">New Session</span>
          </div>
        </header>
        <section class="shell-body" aria-live="polite">
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
                </div>
              </div>
            </div>
          ) : missionId ? (
            <div class="mission-main">
              <MissionTimeline data={data} missionId={missionId} onSelectMission={handleSelectMission} />
              <MissionReceipt data={data} missionId={missionId} />
            </div>
          ) : (
            <p class="shell-empty">
              Views are not ported yet. Unset OPENSAND_RENDERER to use the default renderer.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
