// Sidecar agent roster: lists every registered agent with its enabled state,
// logo, temperature, max tokens, topP, and last-validated key status. Each row
// can be clicked to open the agent's settings detail card.
import { useState, useEffect } from "preact/hooks";
import type { AgentRecord } from "@opensand/shared";
import type { ShellData } from "../data";
import { Avatar } from "./Avatar";

export interface AgentRosterProps {
  data: ShellData;
  onSelect: (agent: AgentRecord) => void;
}

const STATUS_BADGE: Record<string, string> = {
  enabled: "status-ok",
  disabled: "status-off",
  error: "status-error",
  unconfigured: "status-warn",
};

export function AgentRoster({ data, onSelect }: AgentRosterProps) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let mounted = true;
    data.listAgents().then((res) => {
      if (mounted) setAgents(res);
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [data]);

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(query.toLowerCase()) ||
    a.role.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <section class="agent-roster">
      <header class="roster-header">
        <h2 class="roster-title">Agents</h2>
        <input
          type="text"
          class="roster-search"
          placeholder="Filter agents…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <span class="roster-count">{filtered.length} agent{(filtered.length === 1 ? "" : "s")}</span>
      </header>

      {loading ? (
        <p class="roster-empty">Loading agents…</p>
      ) : filtered.length === 0 ? (
        <div class="roster-empty">
          <div class="roster-empty-title">No agents yet</div>
          <div class="roster-empty-desc">Create your first agent to get started.</div>
        </div>
      ) : (
        <ul class="roster-list" role="list" aria-label="Agents">
          {filtered.map((agent) => (
            <li
              key={agent.id}
              class={`roster-item ${(agent.enabled ?? false) ? "enabled" : "disabled"}`}
              onClick={() => onSelect(agent)}
              role="button"
              tabIndex={0}
            >
              <div class="roster-avatar">
                <Avatar agent={agent} size={32} />
                <span class={`status-badge ${STATUS_BADGE[agent.status ?? (agent.enabled ? "enabled" : "disabled")]}`} aria-hidden="true"></span>
              </div>
              <div class="roster-info">
                <div class="roster-name" title={agent.name}>{agent.name}</div>
                <div class="roster-role">{agent.role}</div>
                <div class="roster-meta">
                  {agent.model ? <span class="meta-chip">model: {agent.model}</span> : null}
                  {agent.temperature != null ? <span class="meta-chip">temp: {agent.temperature}</span> : null}
                  {agent.maxTokens != null ? <span class="meta-chip">maxTok: {agent.maxTokens}</span> : null}
                  {agent.topP != null ? <span class="meta-chip">topP: {agent.topP}</span> : null}
                </div>
              </div>
              <svg class="roster-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
