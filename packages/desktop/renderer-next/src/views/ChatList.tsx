import { useState, useEffect } from "preact/hooks";
import type { ShellData, SessionSummary } from "../data";
import {
  filterSessions,
  toRow,
  emptyState,
  type SessionRow,
} from "../../../src/shell/session-list-model";

export interface ChatListProps {
  data: ShellData;
  now?: () => number;
}

export function ChatList({ data, now }: ChatListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);

  const reload = async () => {
    try {
      const res = await data.listSessions();
      setSessions(Array.isArray(res) ? res : []);
    } catch {
      // Keep existing sessions on error
    }
  };

  useEffect(() => {
    let mounted = true;
    data.listSessions().then((res) => {
      if (mounted) {
        setSessions(Array.isArray(res) ? res : []);
      }
    }).catch(() => {
      // Ignored
    });
    return () => {
      mounted = false;
    };
  }, [data]);

  const handleDelete = async (e: MouseEvent, row: SessionRow) => {
    e.stopPropagation();
    if (window.confirm(`Delete conversation "${row.title}"? This cannot be undone.`)) {
      try {
        await data.deleteSession(row.id);
        await reload();
      } catch (err: any) {
        alert(`Error deleting conversation: ${err?.message || err}`);
      }
    }
  };

  const filtered = filterSessions(sessions, query);
  const currentTime = now ? now() : Date.now();
  const rows: SessionRow[] = filtered.map((s) => toRow(s, currentTime, activeId));
  const empty = rows.length === 0 ? emptyState(query) : null;

  return (
    <>
      <div class="sidebar-search-box">
        <svg
          class="search-icon"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          type="text"
          id="conversationSearchInput"
          class="search-input"
          placeholder="Search…"
          aria-label="Search conversations"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      {empty ? (
        <div class="roster-empty">
          <div class="roster-empty-title">{empty.title}</div>
          <div class="roster-empty-desc">{empty.desc}</div>
        </div>
      ) : (
        rows.map((row) => (
          <div
            key={row.id}
            class={`session-channel-item ${row.active ? "active" : ""}`}
            onClick={() => setActiveId(row.id)}
          >
            <div class="channel-avatar" aria-hidden="true">
              {row.avatar}
            </div>
            <div class="channel-info">
              <div class="channel-line-1">
                <span class="channel-title" title={row.title}>
                  {row.title}
                </span>
                <span class="channel-time">{row.timeLabel}</span>
              </div>
              <div class="channel-line-2">
                <span class="channel-snippet">{row.snippet}</span>
                <button
                  class="btn-delete-session"
                  title="Delete conversation"
                  data-session-id={row.id}
                  aria-label="Delete conversation"
                  onClick={(e) => handleDelete(e, row)}
                >
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </>
  );
}
