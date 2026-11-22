/** Per-session message buffers: child/delegated turns are keyed by session id. */
export function createSessionBuffers() {
  const buffers = new Map();
  const unread = new Set();
  return {
    append(sessionId, message) {
      if (!sessionId) return;
      const list = buffers.get(sessionId) ?? [];
      list.push(message);
      if (list.length > 500) list.shift();
      buffers.set(sessionId, list);
      unread.add(sessionId);
    },
    get(sessionId) {
      return [...(buffers.get(sessionId) ?? [])];
    },
    drain(sessionId, knownKeys = new Set()) {
      const list = buffers.get(sessionId) ?? [];
      buffers.delete(sessionId);
      unread.delete(sessionId);
      // A buffered result already rendered from the persisted event log must not
      // be appended a second time when the session is reopened.
      return [...list].filter((m) => !m.dedupeKey || !knownKeys.has(m.dedupeKey));
    },
    hasUnread(sessionId) { return unread.has(sessionId); },
    clear(sessionId) {
      buffers.delete(sessionId);
      unread.delete(sessionId);
    },
  };
}
