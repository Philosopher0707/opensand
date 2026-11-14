// Shell frame for the Preact renderer: sidebar + main area only. Views are
// ported in later slices. Class names and ids match renderer/index.html so the
// shared styles.css (traffic-light clearance, drag regions) applies unchanged.
import type { ShellData } from "./data";
import { ChatList } from "./views/ChatList";
import { MissionList } from "./views/MissionList";

export interface ShellProps {
  data: ShellData;
}

export function Shell({ data }: ShellProps) {
  return (
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="brand" id="brandHomeBtn" role="button" tabIndex={0} title="OpenSand Home">
            <div class="brand-avatar">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" /></svg>
            </div>
            <div class="brand-info">
              <span class="brand-title">OpenSand</span>
              <span class="status-indicator">Ready</span>
            </div>
          </div>
        </div>
        <div id="missionList" class="mission-list-section">
          <MissionList data={data} />
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
          <p class="shell-empty">Views are not ported yet. Unset OPENSAND_RENDERER to use the default renderer.</p>
        </section>
      </main>
    </div>
  );
}
