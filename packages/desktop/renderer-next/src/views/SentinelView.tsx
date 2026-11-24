// Sentinel watchers view (Phase 5 Row 21).
// Replaces the #viewSentinel stub with the watcher grid, diagnostic feed and create modal.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, Watcher, SentinelLog, CreateWatcherInput } from "../data";
import {
  SENTINEL_WATCHERS_EMPTY_STATE,
  SENTINEL_FEED_EMPTY_STATE,
  SENTINEL_VALIDATION_MESSAGE,
  createInitialModalState,
  openCreateWatcherModal,
  closeCreateWatcherModal,
  parseDebounce,
  sentinelLogView,
  validateCreateWatcherInput,
  watcherCardView,
} from "../../../src/shell/sentinel-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface SentinelViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SentinelView({ data, active, onSelect, refreshKey }: SentinelViewProps) {
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [logs, setLogs] = useState<SentinelLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [targetDir, setTargetDir] = useState("");
  const [checkCommand, setCheckCommand] = useState("");
  const [autoHeal, setAutoHeal] = useState(true);
  const [debounce, setDebounce] = useState("500");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [list, feed] = await Promise.all([data.getWatchers(), data.getSentinelLogs()]);
        if (cancelled) return;
        setWatchers(Array.isArray(list) ? list : []);
        setLogs(Array.isArray(feed) ? feed : []);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, refreshKey]);

  // Legacy flow appends live `sentinel` turn events to the diagnostic feed.
  useEffect(() => {
    if (!data.onTurnEvent) return;
    return data.onTurnEvent((event: any) => {
      if (event?.type !== "sentinel" || !event.data) return;
      setLogs((prev) => [...prev.slice(-19), event.data as SentinelLog]);
    });
  }, [data]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      setModals((state) => closeCreateWatcherModal(state));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const reload = async () => {
    try {
      const [list, feed] = await Promise.all([data.getWatchers(), data.getSentinelLogs()]);
      setWatchers(Array.isArray(list) ? list : []);
      setLogs(Array.isArray(feed) ? feed : []);
    } catch {
      // Keep the last successful lists on a refresh failure.
    }
  };

  const handleOpenCreate = () => {
    setTargetDir("");
    setCheckCommand("");
    setAutoHeal(true);
    setDebounce("500");
    setCreateError(null);
    setModals((state) => openCreateWatcherModal(state));
  };

  const handleCreate = async () => {
    const input: CreateWatcherInput = {
      targetDir,
      checkCommand: checkCommand.trim() || undefined,
      autoHeal,
      debounceMs: parseDebounce(debounce),
    };
    const validation = validateCreateWatcherInput(input);
    if (validation) {
      setCreateError(validation);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await data.startWatcher(input);
      setModals((state) => closeCreateWatcherModal(state));
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleStop = async (watcher: Watcher) => {
    if (!window.confirm(`Stop watcher ${watcher.id}?`)) return;
    try {
      await data.stopWatcher(watcher.id);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const group = NAV_GROUPS.find((nav) => nav.tabs.some((tab) => tab.view === "sentinel"));

  return (
    <div id={viewPanelId("sentinel")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container sentinel-view-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "sentinel" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "sentinel" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">🛡️ Workspace Sentinel &amp; Self-Healing</div>
            <div class="dashboard-subtitle">
              Watch directories for changes, run checks and record autonomous healing proposals.
            </div>
          </div>
          <button id="btnOpenCreateWatcher" type="button" class="btn btn-primary" onClick={handleOpenCreate}>
            + New Watcher
          </button>
        </div>

        {loadError && (
          <div class="sentinel-error" role="alert">
            <span>Could not load watchers: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <h3 class="sentinel-section-title">Active Watchers</h3>
        <div class="card-grid" id="sentinelWatchersGrid">
          {loading ? (
            <div class="sentinel-loading">Loading watchers…</div>
          ) : watchers.length === 0 ? (
            <div class="sentinel-empty">{SENTINEL_WATCHERS_EMPTY_STATE}</div>
          ) : (
            watchers.map((watcher) => {
              const card = watcherCardView(watcher);
              return (
                <div class="dashboard-card" key={watcher.id}>
                  <div class="card-top">
                    <div class="card-title">{card.title}</div>
                    <span class={card.statusClass}>{card.statusLabel}</span>
                  </div>
                  <div class="card-desc"><strong>Target:</strong> {card.target}</div>
                  <div class="card-meta">
                    <span class="badge">Check: {card.checkLabel}</span>
                    <span class="badge">Debounce: {card.debounceLabel}</span>
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-stop-watcher"
                      onClick={() => void handleStop(watcher)}
                    >
                      Stop Watcher
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <h3 class="sentinel-section-title">Diagnostic Feed</h3>
        <div class="sentinel-feed" id="sentinelFeed">
          {loading ? (
            <div class="sentinel-loading">Loading events…</div>
          ) : logs.length === 0 ? (
            <div class="sentinel-empty">{SENTINEL_FEED_EMPTY_STATE}</div>
          ) : (
            logs.slice(-20).reverse().map((log, index) => {
              const view = sentinelLogView(log);
              return (
                <div class={view.className} key={`${view.time}-${index}`}>
                  <div class="sentinel-header-row">
                    <div>
                      <span class={view.statusClass}>{view.status}</span>
                      <strong class="sentinel-trigger">Trigger: {view.trigger}</strong>
                    </div>
                    <span class="sentinel-time">{view.time}</span>
                  </div>
                  <div class="sentinel-target">
                    Target: {view.target} | Command: {view.command}
                  </div>
                  {view.output && <div class="sentinel-output-box">{view.output}</div>}
                  {view.healingProposal && (
                    <div>
                      <div class="sentinel-proposal-label">Autonomous Healer Action / Proposal:</div>
                      <div class="sentinel-proposal-box">{view.healingProposal}</div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="createWatcherModal"
        class={`modal-overlay${modals.createWatcherModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createWatcherModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createWatcherModalTitle">Create Workspace Watcher</h3>
            <button
              id="btnCloseCreateWatcher"
              type="button"
              class="btn-close"
              aria-label="Close create watcher dialog"
              onClick={() => setModals((state) => closeCreateWatcherModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="watcherTargetDir">Target directory</label>
              <input
                type="text"
                id="watcherTargetDir"
                class="form-control"
                placeholder="e.g. /Users/me/dev/project"
                value={targetDir}
                onInput={(e) => setTargetDir((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="watcherCheckCommand">Check command (optional)</label>
              <input
                type="text"
                id="watcherCheckCommand"
                class="form-control"
                placeholder="e.g. pnpm test"
                value={checkCommand}
                onInput={(e) => setCheckCommand((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group sentinel-check-row">
              <input
                type="checkbox"
                id="watcherAutoHeal"
                checked={autoHeal}
                onChange={(e) => setAutoHeal((e.currentTarget as HTMLInputElement).checked)}
              />
              <label for="watcherAutoHeal">Auto-heal on trigger</label>
            </div>
            <div class="form-group">
              <label for="watcherDebounce">Debounce (milliseconds)</label>
              <input
                type="number"
                id="watcherDebounce"
                class="form-control"
                value={debounce}
                onInput={(e) => setDebounce((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div id="watcherFormError" class="sentinel-form-error" role={createError ? "alert" : undefined}>
              {createError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveWatcher"
              type="button"
              class="btn btn-primary"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Starting..." : "Start Watcher"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
