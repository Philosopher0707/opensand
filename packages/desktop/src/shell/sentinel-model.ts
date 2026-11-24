// Pure model for the Sentinel watchers view (Phase 5 Row 21).
// Mirrors the legacy renderer/app.js sentinel controller without DOM or bridge code.

export interface Watcher {
  id: string;
  targetDir?: string;
  checkCommand?: string;
  autoHeal?: boolean;
  debounceMs?: number;
  [key: string]: unknown;
}

export interface SentinelLog {
  status?: string;
  triggerFile?: string;
  targetDir?: string;
  checkCommand?: string;
  output?: string;
  healingProposal?: string;
  timestampMs?: number;
  [key: string]: unknown;
}

export interface CreateWatcherInput {
  targetDir: string;
  checkCommand?: string;
  autoHeal: boolean;
  debounceMs: number;
}

export interface WatcherCardView {
  title: string;
  statusLabel: string;
  statusClass: string;
  target: string;
  checkLabel: string;
  debounceLabel: string;
}

export interface SentinelLogView {
  className: string;
  status: string;
  statusClass: string;
  trigger: string;
  time: string;
  target: string;
  command: string;
  output: string;
  healingProposal: string;
}

export interface SentinelModalState {
  createWatcherModalOpen: boolean;
}

export const SENTINEL_WATCHERS_EMPTY_STATE =
  'No active workspace watchers. Click "+ New Watcher" to monitor code changes and enable auto-healing.';
export const SENTINEL_FEED_EMPTY_STATE =
  "No diagnostic events recorded yet. Modify a file in a watched directory to trigger Sentinel.";
export const SENTINEL_VALIDATION_MESSAGE = "Please specify target directory to watch.";

/** Matches the legacy `if (!targetDir)` guard before startWatcher. */
export function validateCreateWatcherInput(input: CreateWatcherInput): string | null {
  return input.targetDir?.trim() ? null : SENTINEL_VALIDATION_MESSAGE;
}

/** Matches the legacy `parseInt(value, 10) || 500` default. */
export function parseDebounce(raw: string): number {
  return parseInt(raw, 10) || 500;
}

export function watcherCardView(watcher: Watcher): WatcherCardView {
  return {
    title: watcher.id || "Untitled watcher",
    statusLabel: watcher.autoHeal ? "Auto-Heal Active" : "Passive",
    statusClass: watcher.autoHeal ? "badge badge-success" : "badge",
    target: watcher.targetDir?.trim() || "—",
    checkLabel: watcher.checkCommand?.trim() || "Filesystem Only",
    debounceLabel: `${parseDebounce(String(watcher.debounceMs ?? 500))}ms`,
  };
}

export function sentinelLogView(log: SentinelLog): SentinelLogView {
  const status = log.status || "clean";
  return {
    className: `sentinel-item ${status}`,
    status,
    statusClass: `status-badge ${status}`,
    trigger: log.triggerFile || "change",
    time: new Date(log.timestampMs || Date.now()).toLocaleTimeString(),
    target: log.targetDir || "",
    command: log.checkCommand || "N/A",
    output: log.output || "",
    healingProposal: log.healingProposal || "",
  };
}

export function createInitialModalState(): SentinelModalState {
  return { createWatcherModalOpen: false };
}

export function openCreateWatcherModal(state: SentinelModalState): SentinelModalState {
  return { ...state, createWatcherModalOpen: true };
}

export function closeCreateWatcherModal(state: SentinelModalState): SentinelModalState {
  return { ...state, createWatcherModalOpen: false };
}
