// Shell frame for the Preact renderer: sidebar + main area only. Views are
// ported in later slices. Class names and ids match renderer/index.html so the
// shared styles.css (traffic-light clearance, drag regions) applies unchanged.
import { useState } from "preact/hooks";
import type { ShellData } from "./data";
import { ChatList } from "./views/ChatList";
import { AgentRoster } from "./views/AgentRoster";
import { AgentSettingsCard } from "./views/AgentSettingsCard";
import type { AgentRecord } from "@opensand/shared";

export interface ShellProps {
  data: ShellData;
}

export function Shell({ data }: ShellProps) {
  const [activeAgent, setActiveAgent] = useState<AgentRecord | null>(null);

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
        <div id="sessionList" class="session-list" role="list" aria-label="Sessions">
          <ChatList data={data} />
        </div>
        <div class="agent-roster-panel" id="agentRosterPanel" role="region" aria-label="Agents">
          <AgentRoster data={data} onSelect={setActiveAgent} />
        </div>
        <div class="sidebar-footer">
          <span class="shell-note">Preact shell (preview)</span>
        </div>
      </aside>
      <main class="main-panel">
        <header class="topbar">
          <div class="topbar-left">
            <h1 class="view-header-title" id="viewHeaderTitle">{activeAgent ? activeAgent.name : "Home"}</h1>
            <span class="active-session-title" id="activeSessionTitle">{activeAgent ? "Agent Settings" : "New Session"}</span>
          </div>
        </header>
        <section class="shell-body" aria-live="polite">
          {activeAgent ? (
            <AgentSettingsCard data={data} agent={activeAgent} />
          ) : (
            <p class="shell-empty">Select an agent from the sidebar to view its settings.</p>
          )}
        </section>
      </main>
    </div>
  );
}
