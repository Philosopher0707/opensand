// Pure model for the Scheduled Background Routines view (Phase 5 Row 14).
// Mirrors the legacy renderer/app.js routine controller without importing any DOM or bridge code.

export type RoutineLastRunStatus = "success" | "error" | "running";

export interface Routine {
  routineId: string;
  name: string;
  recordJson?: string | null;
  triggerDescription?: string;
  nextRunAtMs?: number | null;
  runCount?: number;
  isEnabled?: boolean;
  lastRunStatus?: RoutineLastRunStatus;
  [key: string]: unknown;
}

export interface CreateRoutineInput {
  name: string;
  prompt: string;
  scheduleType: "interval" | "cron";
  intervalMinutes: number;
  cron?: string;
}

export interface RoutineStatusBadge {
  label: string;
  tone: "success" | "danger" | "warning" | "neutral";
}

export interface RoutinesModalState {
  createRoutineModalOpen: boolean;
}

export const ROUTINE_VALIDATION_MESSAGE = "Please provide routine name and prompt instructions.";
export const ROUTINE_EMPTY_STATE = 'No background routines configured. Click "+ New Routine" to schedule one.';

/** Legacy parity: `parseInt(...) || 60`, but negative intervals stay invalid for the validator. */
export function normalizeIntervalMinutes(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed === 0) return 60;
  return Math.floor(parsed);
}

export function validateCreateRoutineInput(input: CreateRoutineInput): string | null {
  if (!input.name.trim() || !input.prompt.trim()) return ROUTINE_VALIDATION_MESSAGE;
  if (input.scheduleType === "cron") {
    return input.cron?.trim() ? null : "Please provide a cron expression.";
  }
  return normalizeIntervalMinutes(input.intervalMinutes) < 1 ? "Interval must be at least 1 minute." : null;
}

export function routineStatusBadge(lastRunStatus?: RoutineLastRunStatus): RoutineStatusBadge {
  switch (lastRunStatus) {
    case "success": return { label: "✓ Success", tone: "success" };
    case "error": return { label: "✗ Error", tone: "danger" };
    case "running": return { label: "⚡ Running", tone: "warning" };
    default: return { label: "Idle", tone: "neutral" };
  }
}

/** Reads the action prompt from the opaque record; a bad recordJson must never break the card. */
export function routineActionText(routine: Routine): string {
  try {
    const record = JSON.parse(typeof routine.recordJson === "string" ? routine.recordJson : "{}");
    if (record && typeof record.prompt === "string" && record.prompt.trim()) return record.prompt;
  } catch {
    // Fall through to the name.
  }
  return routine.name || "Untitled routine";
}

export function formatNextRun(nextRunAtMs?: number | null): string {
  if (typeof nextRunAtMs !== "number" || !Number.isFinite(nextRunAtMs)) return "Disabled";
  return new Date(nextRunAtMs).toLocaleTimeString();
}

export function toggleLabel(isEnabled?: boolean): "Pause" | "Enable" {
  return isEnabled ? "Pause" : "Enable";
}

export function createInitialModalState(): RoutinesModalState {
  return { createRoutineModalOpen: false };
}

export function openCreateRoutineModal(state: RoutinesModalState): RoutinesModalState {
  return { ...state, createRoutineModalOpen: true };
}

export function closeCreateRoutineModal(state: RoutinesModalState): RoutinesModalState {
  return { ...state, createRoutineModalOpen: false };
}
