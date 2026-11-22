// packages/desktop/src/shell/account-model.ts
// Pure state logic for the Preact shell's account menu, theme, sidebar and shortcuts (Phase 5, Row 11).
// Mirrors legacy renderer/app.js L1241-1313, 4190-4234 and 4920-4942.

export type Theme = "dark" | "light";

export const THEME_KEY = "opensand-theme";
export const SIDEBAR_KEY = "opensand-sidebar-collapsed";

/** The subset of Storage the shell needs; pass `null` where storage is unavailable. */
export interface ShellStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AccountState {
  theme: Theme;
  sidebarCollapsed: boolean;
  accountPopupOpen: boolean;
}

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === "dark" || stored === "light") return stored;
  return prefersDark ? "dark" : "light";
}

export function toggleTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

export function resolveSidebarCollapsed(stored: string | null): boolean {
  return stored === "true";
}

/** `force` wins when it is an explicit boolean; otherwise flip the current value. */
export function nextSidebarCollapsed(collapsed: boolean, force?: boolean): boolean {
  return typeof force === "boolean" ? force : !collapsed;
}

export function readTheme(storage: ShellStorage | null | undefined, prefersDark: boolean): Theme {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(THEME_KEY) ?? null;
  } catch {}
  return resolveTheme(stored, prefersDark);
}

export function readSidebarCollapsed(storage: ShellStorage | null | undefined): boolean {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(SIDEBAR_KEY) ?? null;
  } catch {}
  return resolveSidebarCollapsed(stored);
}

export function persistTheme(storage: ShellStorage | null | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {}
}

export function persistSidebarCollapsed(storage: ShellStorage | null | undefined, collapsed: boolean): void {
  try {
    storage?.setItem(SIDEBAR_KEY, String(collapsed));
  } catch {}
}

export type ShortcutAction = "toggle-sidebar" | "toggle-detail" | "toggle-canvas" | "escape";

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** Map a keydown to one shell action; `null` means the key belongs to something else. */
export function classifyShortcut(event: KeyLike): ShortcutAction | null {
  if (event.key === "Escape" || event.key === "Esc") return "escape";
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = String(event.key || "").toLowerCase();
  if (key === "b" && !event.shiftKey) return "toggle-sidebar";
  if (key === "i" && !event.shiftKey) return "toggle-detail";
  if (key === "a" && event.shiftKey) return "toggle-canvas";
  return null;
}

export type EscapeTarget = "account-popup" | "exit-fullscreen" | "canvas" | "detail" | "cancel-turn" | "none";

export interface EscapeState {
  accountPopupOpen: boolean;
  canvasOpen: boolean;
  isFullscreen: boolean;
  detailOpen: boolean;
  turnBusy: boolean;
}

/** Esc closes the topmost layer first, then stops a busy turn (legacy precedence + account popup). */
export function resolveEscapeTarget(state: EscapeState): EscapeTarget {
  if (state.accountPopupOpen) return "account-popup";
  if (state.canvasOpen) return state.isFullscreen ? "exit-fullscreen" : "canvas";
  if (state.detailOpen) return "detail";
  if (state.turnBusy) return "cancel-turn";
  return "none";
}
