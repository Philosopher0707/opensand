// Agent session history: lists sessions for a given agent with predicted vs
// observed outcomes. Clicking a row loads the session transcript.
import { useState, useEffect } from "preact/hooks";
import type { SessionSummary } from "../../src/shell/session-list-model";
import type { ShellData } from "../data";

export interface AgentSessionHistoryProps {
  data: ShellData;
  agentId: string | null;
  onSelectSession: (sessionId: string) => void;
}

const OUTCOME_COLOR: Record<string, string> = {
  positive: "outcome-positive",
  negative: "outcome-negative",
  uncertain: "outcome-uncertain",
  pending: "outcome-pending",
};

export function AgentSessionHistory({ data, agentId, onSelectSession }: AgentSessionHistoryProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentId) {
      setSessions([]);
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    data.listSessions().then((all) => {
      if (!mounted) return;
      const mine = all.filter((s) => s.agentId === agentId);
      setSessions(mine);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [data, agentId]);

  if (!agentId) return null;

  return (
    <section class="agent-session-history">
      <header class="history-header">
        <h2 class="history-title">Sessions</h2>
        <span class="history-count">{sessions.length}</span>
      </header>

      {loading ? (
        <p class="history-empty">Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <div class="history-empty">
          <div class="history-empty-title">No sessions yet</div>
          <div class="history-empty-desc">Start a conversation with this agent to see its history.</div>
        </div>
      ) : (
        <ul class="history-list" role="list" aria-label="Sessions">
          {sessions.map((session) => (
            <li
              key={session.id}
              class="history-item"
              onClick={() => onSelectSession(session.id)}
              role="button"
              tabIndex={0}
            >
              <div class="history-info">
                <div class="history-title-text" title={session.title || session.id}>
                  {session.title || session.id}
                </div>
                <div class="history-meta">
                  <span class="meta-chip">{new Date(session.updatedAt).toLocaleDateString()}</span>
                  <span class="meta-chip">{session.messageCount} message{(session.messageCount === 1 ? "" : "s")}</span>
                </div>
              </div>
              <div class="history-outcomes">
                <span class={`outcome-badge ${OUTCOME_COLOR[session.predictedOutcome ?? "pending"]}`} title={`Predicted: ${session.predictedOutcome ?? "pending"}`}>
                  P: {session.predictedOutcome ?? "pending"}
                </span>
                <span class={`outcome-badge ${OUTCOME_COLOR[session.observedOutcome ?? "pending"]}`} title={`Observed: ${session.observedOutcome ?? "pending"}`}>
                  O: {session.observedOutcome ?? "pending"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
