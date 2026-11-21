/** Per-session message buffers: child/delegated turns are keyed by session id. */
export function createSessionBuffers() {
  const buffers = new Map();
  return {
    append(sessionId, message) {
      if (!sessionId) return;
      const list = buffers.get(sessionId) ?? [];
      list.push(message);
      if (list.length > 500) list.shift();
      buffers.set(sessionId, list);
    },
    get(sessionId) {
      return [...(buffers.get(sessionId) ?? [])];
    },
    renderInto(sessionId, feedEl, renderMessage) {
      if (!feedEl) return;
      feedEl.innerHTML = '';
      for (const message of buffers.get(sessionId)) {
        feedEl.appendChild(renderMessage(message));
      }
    },
    has(sessionId) { return buffers.has(sessionId); },
    clear(sessionId) { buffers.delete(sessionId); },
  };
}
