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
    drain(sessionId) {
      const list = buffers.get(sessionId) ?? [];
      buffers.delete(sessionId);
      unread.delete(sessionId);
      return [...list];
    },
    hasUnread(sessionId) { return unread.has(sessionId); },
    clear(sessionId) {
      buffers.delete(sessionId);
      unread.delete(sessionId);
    },
  };
}
