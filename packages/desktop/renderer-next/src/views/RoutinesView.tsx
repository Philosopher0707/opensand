// Scheduled Background Routines view (Phase 5 Row 14).
// Replaces the #viewRoutines stub with the routine grid and the New Routine modal.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, Routine, CreateRoutineInput } from "../data";
import {
  normalizeIntervalMinutes,
  validateCreateRoutineInput,
  routineStatusBadge,
  routineActionText,
  formatNextRun,
  toggleLabel,
  createInitialModalState,
  openCreateRoutineModal,
  closeCreateRoutineModal,
  ROUTINE_EMPTY_STATE,
} from "../../../src/shell/routines-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface RoutinesViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function RoutinesView({ data, active, onSelect, refreshKey }: RoutinesViewProps) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [routineName, setRoutineName] = useState("");
  const [routinePrompt, setRoutinePrompt] = useState("");
  const [scheduleType, setScheduleType] = useState<"interval" | "cron">("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cron, setCron] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await data.getRoutines();
        if (cancelled) return;
        setRoutines(Array.isArray(list) ? list : []);
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

  useEffect(() => {
    if (!modals.createRoutineModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModals((state) => closeCreateRoutineModal(state));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modals.createRoutineModalOpen]);

  const reload = async () => {
    try {
      const list = await data.getRoutines();
      setRoutines(Array.isArray(list) ? list : []);
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const handleOpenCreate = () => {
    setRoutineName("");
    setRoutinePrompt("");
    setScheduleType("interval");
    setIntervalMinutes(60);
    setCron("");
    setCreateError(null);
    setModals((state) => openCreateRoutineModal(state));
  };

  const handleCreate = async () => {
    const input: CreateRoutineInput = {
      name: routineName,
      prompt: routinePrompt,
      scheduleType,
      intervalMinutes: normalizeIntervalMinutes(intervalMinutes),
      cron: cron.trim() || undefined,
    };
    const validation = validateCreateRoutineInput(input);
    if (validation) {
      setCreateError(validation);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await data.createRoutine(input);
      setModals((state) => closeCreateRoutineModal(state));
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleTrigger = async (routine: Routine) => {
    setRunningId(routine.routineId);
    try {
      await data.triggerRoutine(routine.routineId);
    } catch {
      // Keep the last successful list; the run result is reported by the server.
    } finally {
      setRunningId(null);
      await reload();
    }
  };

  const handleToggle = async (routine: Routine) => {
    try {
      await data.setRoutineEnabled(routine.routineId, !routine.isEnabled);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const handleDelete = async (routine: Routine) => {
    if (!window.confirm(`Delete routine "${routine.name}"?`)) return;
    try {
      await data.deleteRoutine(routine.routineId);
      await reload();
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const capabilities = NAV_GROUPS.find((group) => group.id === "capabilities");

  return (
    <div id={viewPanelId("routines")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container routines-view-container">
        {capabilities && (
          <nav class="subnav-tabs" data-group={capabilities.id} aria-label="Capabilities views">
            {capabilities.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "routines" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "routines" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">⏱ Scheduled Background Routines</div>
            <div class="dashboard-subtitle">
              Automated workflows running on recurring cron expressions or interval tickers with secret redaction.
            </div>
          </div>
          <button id="btnOpenCreateRoutine" type="button" class="btn btn-primary" onClick={handleOpenCreate}>
            + New Routine
          </button>
        </div>

        {loadError && (
          <div class="routines-error" role="alert">
            <span>Could not load routines: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="card-grid" id="routinesCardGrid">
          {loading ? (
            <div class="routines-loading">Loading routines…</div>
          ) : routines.length === 0 ? (
            <div class="routines-empty">{ROUTINE_EMPTY_STATE}</div>
          ) : (
            routines.map((routine) => {
              const badge = routineStatusBadge(routine.lastRunStatus);
              const badgeClass = badge.tone === "neutral" ? "badge" : `badge badge-${badge.tone}`;
              const isRunning = runningId === routine.routineId;
              return (
                <div class="dashboard-card" key={routine.routineId}>
                  <div class="card-top">
                    <div class="card-title">⏱ {routine.name}</div>
                    <span class={badgeClass}>{badge.label}</span>
                  </div>
                  <div class="card-desc"><strong>Action:</strong> {routineActionText(routine)}</div>
                  <div class="card-meta">
                    <span class="badge">{routine.triggerDescription || "No schedule"}</span>
                    <span class="badge">Next: {formatNextRun(routine.nextRunAtMs)}</span>
                    <span class="badge">Runs: {routine.runCount || 0}</span>
                  </div>
                  <div class="card-footer">
                    <div class="routine-actions">
                      <button
                        type="button"
                        class="btn btn-secondary btn-xs btn-trigger"
                        disabled={isRunning}
                        onClick={() => void handleTrigger(routine)}
                      >
                        {isRunning ? "Running..." : "Run Now"}
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs btn-toggle"
                        onClick={() => void handleToggle(routine)}
                      >
                        {toggleLabel(routine.isEnabled)}
                      </button>
                    </div>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-del-routine"
                      onClick={() => void handleDelete(routine)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="createRoutineModal"
        class={`modal-overlay${modals.createRoutineModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createRoutineModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createRoutineModalTitle">New Scheduled Routine</h3>
            <button
              id="btnCloseCreateRoutine"
              type="button"
              class="btn-close"
              aria-label="Close create routine dialog"
              onClick={() => setModals((state) => closeCreateRoutineModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="routineName">Routine Name</label>
              <input
                type="text"
                id="routineName"
                class="form-control"
                placeholder="e.g. Hourly System Diagnostics"
                value={routineName}
                onInput={(e) => setRoutineName((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="routinePrompt">Action Prompt / Instructions</label>
              <textarea
                id="routinePrompt"
                class="form-control"
                rows={3}
                placeholder="e.g. Check disk space, git status, and error logs..."
                value={routinePrompt}
                onInput={(e) => setRoutinePrompt((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="routineScheduleType">Schedule Frequency</label>
              <select
                id="routineScheduleType"
                class="form-control"
                value={scheduleType}
                onChange={(e) => setScheduleType((e.currentTarget as HTMLSelectElement).value as "interval" | "cron")}
              >
                <option value="interval">Interval (Every N minutes)</option>
                <option value="cron">Cron Expression (5-part standard)</option>
              </select>
            </div>
            <div class={`form-group${scheduleType === "interval" ? "" : " hidden"}`} id="groupInterval">
              <label for="routineIntervalMinutes">Interval Minutes</label>
              <input
                type="number"
                id="routineIntervalMinutes"
                class="form-control"
                min={1}
                value={intervalMinutes}
                onInput={(e) => setIntervalMinutes(Number((e.currentTarget as HTMLInputElement).value))}
              />
            </div>
            <div class={`form-group${scheduleType === "cron" ? "" : " hidden"}`} id="groupCron">
              <label for="routineCron">Cron Expression</label>
              <input
                type="text"
                id="routineCron"
                class="form-control"
                placeholder="0 9 * * *"
                value={cron}
                onInput={(e) => setCron((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div id="routineFormError" class="routine-form-error" role={createError ? "alert" : undefined}>
              {createError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveRoutine"
              type="button"
              class="btn btn-primary"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Creating..." : "Save Routine"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
