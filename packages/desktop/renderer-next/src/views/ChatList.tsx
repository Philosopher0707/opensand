import { useState, useEffect, useCallback } from "preact/hooks";
import type { ShellData, SessionSummary } from "../data";
import {
  filterSessions,
  toRow,
  emptyState,
  SESSIONS_CHANGED_EVENT,
  validateSessionTitle,
  formatSessionError,
  type SessionRow,
} from "../../../src/shell/session-list-model";

export interface ChatListProps {
  data: ShellData;
  now?: () => number;
  selectedSessionId?: string | null;
  onSelectSession?: (id: string, title?: string) => void;
  onDeleteSession?: (id: string) => void;
}

export function ChatList({
  data,
  now,
  selectedSessionId,
  onSelectSession,
  onDeleteSession,
}: ChatListProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(selectedSessionId ?? null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedSessionId !== undefined) {
      setActiveId(selectedSessionId);
      if (selectedSessionId) {
        setSessions((prev) =>
          prev.map((s) => (s.id === selectedSessionId && s.unreadCount ? { ...s, unreadCount: 0 } : s)),
        );
      }
    }
  }, [selectedSessionId]);

  const reload = useCallback(async () => {
    try {
      const res = await data.listSessions();
      setSessions(Array.isArray(res) ? res : []);
    } catch {
      // Keep existing sessions on error
    }
  }, [data]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // New turns, session creation, rename and delete all fire this from the data layer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => { void reload(); };
    window.addEventListener(SESSIONS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, handler);
  }, [reload]);

  const handleSelect = (row: SessionRow) => {
    setActiveId(row.id);
    if (row.unreadCount && row.unreadCount > 0) {
      setSessions((prev) =>
        prev.map((s) => (s.id === row.id ? { ...s, unreadCount: 0 } : s)),
      );
    }
    onSelectSession?.(row.id, row.title);
  };

  const handleDeleteClick = (e: Event, row: SessionRow) => {
    e.stopPropagation();
    setError(null);
    setRenamingId(null);
    setConfirmingDeleteId((id) => (id === row.id ? null : row.id));
  };

  const handleConfirmDelete = async (e: Event, row: SessionRow) => {
    e.stopPropagation();
    setConfirmingDeleteId(null);
    setError(null);
    try {
      await data.deleteSession(row.id);
      if ((activeId ?? selectedSessionId ?? null) === row.id) {
        setActiveId(null);
      }
      onDeleteSession?.(row.id);
      await reload();
    } catch (err) {
      setError(formatSessionError(err, "delete the conversation"));
    }
  };

  const handleRenameStart = (e: Event, row: SessionRow) => {
    e.stopPropagation();
    setError(null);
    setConfirmingDeleteId(null);
    setRenamingId(row.id);
    setRenameDraft(row.title);
  };

  const handleRenameSave = async (e: Event, row: SessionRow) => {
    e.stopPropagation();
    const title = validateSessionTitle(renameDraft);
    if (!title) {
      setError("Enter a conversation name before saving.");
      return;
    }
    setError(null);
    try {
      const ok = await data.renameSession(row.id, title);
      if (!ok) {
        setError("That conversation no longer exists.");
        return;
      }
      setRenamingId(null);
      setRenameDraft("");
      setSessions((prev) => prev.map((s) => (s.id === row.id ? { ...s, title } : s)));
      onSelectSession?.(row.id, title);
      await reload();
    } catch (err) {
      setError(formatSessionError(err, "rename the conversation"));
    }
  };

  const handleRenameCancel = (e: Event) => {
    e.stopPropagation();
    setRenamingId(null);
    setRenameDraft("");
    setError(null);
  };

  const filtered = filterSessions(sessions, query);
  const currentTime = now ? now() : Date.now();
  const effectiveActiveId = activeId ?? selectedSessionId ?? null;
  const rows: SessionRow[] = filtered.map((s) => toRow(s, currentTime, effectiveActiveId));
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

      {error && (
        <div class="session-list-error" role="alert" style="display:flex;gap:8px;align-items:center;padding:6px 10px;color:#f87171;font-size:12px">
          <span>{error}</span>
          <button
            type="button"
            class="btn-delete-session"
            aria-label="Dismiss error"
            title="Dismiss error"
            onClick={(e) => { e.stopPropagation(); setError(null); }}
          >
            ×
          </button>
        </div>
      )}

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
            data-session-id={row.id}
            onClick={() => handleSelect(row)}
          >
            <div class="channel-avatar" aria-hidden="true">
              {row.avatar}
            </div>
            <div class="channel-info">
              <div class="channel-line-1">
                <span class="channel-title" title={row.title}>
                  {row.title}
                </span>
                {row.unreadCount !== undefined && row.unreadCount > 0 && (
                  <span class="channel-unread-badge" aria-label={`${row.unreadCount} unread`}>
                    {row.unreadCount}
                  </span>
                )}
                <span class="channel-time">{row.timeLabel}</span>
              </div>
              <div class="channel-line-2" onClick={(e) => e.stopPropagation()}>
                {renamingId === row.id ? (
                  <span class="rename-form" style="display:flex;gap:4px;align-items:center;flex:1">
                    <input
                      type="text"
                      class="search-input"
                      aria-label={`Rename conversation ${row.title}`}
                      value={renameDraft}
                      autoFocus
                      onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRenameSave(e, row);
                        else if (e.key === "Escape") handleRenameCancel(e);
                      }}
                    />
                    <button
                      type="button"
                      class="btn-rename-session"
                      title="Save name"
                      aria-label="Save name"
                      onClick={(e) => handleRenameSave(e, row)}
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      class="btn-rename-session"
                      title="Cancel rename"
                      aria-label="Cancel rename"
                      onClick={handleRenameCancel}
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <>
                    <span class="channel-snippet">{row.snippet}</span>
                    <button
                      type="button"
                      class="btn-rename-session"
                      title="Rename conversation"
                      data-session-id={row.id}
                      aria-label={`Rename conversation ${row.title}`}
                      onClick={(e) => handleRenameStart(e, row)}
                    >
                      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="btn-delete-session"
                      title="Delete conversation"
                      data-session-id={row.id}
                      aria-label="Delete conversation"
                      onClick={(e) => handleDeleteClick(e, row)}
                    >
                      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              {confirmingDeleteId === row.id && (
                <div class="delete-confirm" role="group" aria-label={`Confirm delete ${row.title}`} style="display:flex;gap:6px;align-items:center;padding:6px 0;font-size:12px" onClick={(e) => e.stopPropagation()}>
                  <span>Delete this conversation?</span>
                  <button
                    type="button"
                    class="btn-delete-session"
                    aria-label="Confirm delete"
                    onClick={(e) => handleConfirmDelete(e, row)}
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    class="btn-rename-session"
                    aria-label="Cancel delete"
                    onClick={(e) => { e.stopPropagation(); setConfirmingDeleteId(null); }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}
