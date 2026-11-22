import type { Routine, CreateRoutineInput } from "../../../src/shell/routines-model";

export interface RoutinesData {
  getRoutines(): Promise<Routine[]>;
  createRoutine(payload: CreateRoutineInput): Promise<Routine>;
  setRoutineEnabled(routineId: string, isEnabled: boolean): Promise<Routine>;
  triggerRoutine(routineId: string): Promise<unknown>;
  deleteRoutine(routineId: string): Promise<void>;
}

export function routinesData(bridge?: any, http?: typeof fetch): RoutinesData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getRoutines(): Promise<Routine[]> {
      if (typeof window !== "undefined" && (window as any).__testRoutines !== undefined) {
        return (window as any).__testRoutines;
      }
      const b = getBridge();
      if (b?.getRoutines) {
        try {
          const res = await b.getRoutines();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/routines") : await fetch("/api/routines");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createRoutine(payload: CreateRoutineInput): Promise<Routine> {
      const b = getBridge();
      if (b?.createRoutine) {
        try {
          return await b.createRoutine(payload);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http("/api/routines", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/routines", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not create routine (HTTP ${res.status})`);
      return data as Routine;
    },

    async setRoutineEnabled(routineId: string, isEnabled: boolean): Promise<Routine> {
      const b = getBridge();
      if (b?.setRoutineEnabled) {
        try {
          return await b.setRoutineEnabled(routineId, isEnabled);
        } catch {
          // fall through to the HTTP route
        }
      }
      // The desktop server registers PATCH here (legacy parity); POST is not a valid route.
      const res = http
        ? await http(`/api/routines/${encodeURIComponent(routineId)}/enabled`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isEnabled }),
          })
        : await fetch(`/api/routines/${encodeURIComponent(routineId)}/enabled`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isEnabled }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not update routine (HTTP ${res.status})`);
      return data as Routine;
    },

    async triggerRoutine(routineId: string): Promise<unknown> {
      const b = getBridge();
      if (b?.triggerRoutine) {
        try {
          return await b.triggerRoutine(routineId);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/routines/${encodeURIComponent(routineId)}/trigger`, { method: "POST" })
        : await fetch(`/api/routines/${encodeURIComponent(routineId)}/trigger`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not run routine (HTTP ${res.status})`);
      return data;
    },

    async deleteRoutine(routineId: string): Promise<void> {
      const b = getBridge();
      if (b?.deleteRoutine) {
        try {
          await b.deleteRoutine(routineId);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" })
        : await fetch(`/api/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not delete routine (HTTP ${res.status})`);
      }
    },
  };
}
