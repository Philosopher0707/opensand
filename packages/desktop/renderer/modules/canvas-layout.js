/**
 * Pure geometry for the agent canvas. No DOM, no state — safe to unit test.
 * Every loop is bounded: a canvas must never hang while arranging windows.
 */

export const MIN_WINDOW_WIDTH = 320;
export const MIN_WINDOW_HEIGHT = 260;
export const MAX_WINDOWS = 6;

const number = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));

/** Keep a window reachable inside the visible canvas area. */
export function clampWindow(window, bounds = {}) {
  const maxWidth = Math.max(MIN_WINDOW_WIDTH, number(bounds.w, 1200));
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, number(bounds.h, 800));
  const w = clamp(number(window.w, MIN_WINDOW_WIDTH), MIN_WINDOW_WIDTH, maxWidth);
  const h = clamp(number(window.h, MIN_WINDOW_HEIGHT), MIN_WINDOW_HEIGHT, maxHeight);
  return {
    ...window,
    x: clamp(number(window.x, 0), 0, Math.max(0, maxWidth - w)),
    y: clamp(number(window.y, 0), 0, Math.max(0, maxHeight - h)),
    w,
    h,
  };
}

/** Cascade a new window near the preferred point without stacking it exactly. */
export function cascadePosition(windows, preferred = {}, bounds = {}) {
  const step = 28;
  const maxWidth = Math.max(MIN_WINDOW_WIDTH, number(bounds.w, 1200));
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, number(bounds.h, 800));
  const startX = clamp(number(preferred.x, 48), 0, Math.max(0, maxWidth - MIN_WINDOW_WIDTH));
  const startY = clamp(number(preferred.y, 48), 0, Math.max(0, maxHeight - MIN_WINDOW_HEIGHT));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const x = clamp(startX + attempt * step, 0, Math.max(0, maxWidth - MIN_WINDOW_WIDTH));
    const y = clamp(startY + attempt * step, 0, Math.max(0, maxHeight - MIN_WINDOW_HEIGHT));
    const collides = windows.some(
      (other) => Math.abs(number(other.x, 0) - x) < step && Math.abs(number(other.y, 0) - y) < step,
    );
    if (!collides) return { x, y };
  }
  return { x: startX, y: startY };
}

/** Zoom/pan that brings every window into view, capped so text stays legible. */
export function fitAll(windows, bounds = {}) {
  if (!windows.length) return { panX: 0, panY: 0, zoom: 1 };
  const width = Math.max(1, number(bounds.w, 1200));
  const height = Math.max(1, number(bounds.h, 800));
  const minX = Math.min(...windows.map((w) => number(w.x, 0)));
  const minY = Math.min(...windows.map((w) => number(w.y, 0)));
  const maxX = Math.max(...windows.map((w) => number(w.x, 0) + number(w.w, MIN_WINDOW_WIDTH)));
  const maxY = Math.max(...windows.map((w) => number(w.y, 0) + number(w.h, MIN_WINDOW_HEIGHT)));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const padding = 32;
  const zoom = clamp(
    Math.min(1, (width - padding * 2) / spanX, (height - padding * 2) / spanY),
    0.5,
    1,
  );
  return {
    zoom,
    panX: (width - spanX * zoom) / 2 - minX * zoom,
    panY: (height - spanY * zoom) / 2 - minY * zoom,
  };
}

/**
 * Validate a persisted layout. Unknown sessions are returned separately so the
 * UI can report them instead of opening ghost windows.
 */
export function normalizePersisted(raw, sessionIds = [], bounds = {}) {
  const empty = { windows: [], orphans: [], viewport: { panX: 0, panY: 0, zoom: 1 }, mode: 'overview' };
  if (!raw || typeof raw !== 'object') return empty;
  const known = new Set(Array.isArray(sessionIds) ? sessionIds : []);
  const canValidate = known.size > 0;
  const windows = [];
  const orphans = [];
  for (const item of (Array.isArray(raw.windows) ? raw.windows : []).slice(0, MAX_WINDOWS)) {
    if (!item || typeof item.sessionId !== 'string' || !item.sessionId) continue;
    if (canValidate && !known.has(item.sessionId)) {
      orphans.push(item.sessionId);
      continue;
    }
    windows.push(
      clampWindow(
        {
          id: `win-${number(item.z, windows.length + 1)}`,
          sessionId: item.sessionId,
          agentId: typeof item.agentId === 'string' ? item.agentId : null,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          z: number(item.z, windows.length + 1),
          minimized: item.minimized === true,
        },
        bounds,
      ),
    );
  }
  const view = raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {};
  return {
    windows,
    orphans,
    viewport: {
      panX: number(view.panX, 0),
      panY: number(view.panY, 0),
      zoom: clamp(number(view.zoom, 1), 0.5, 2),
    },
    mode: raw.mode === 'follow' ? 'follow' : 'overview',
  };
}
