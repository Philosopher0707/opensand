import type { Watcher, SentinelLog, CreateWatcherInput } from "../../../src/shell/sentinel-model";

export interface SentinelData {
  getWatchers(): Promise<Watcher[]>;
  getSentinelLogs(watcherId?: string): Promise<SentinelLog[]>;
  startWatcher(payload: CreateWatcherInput): Promise<unknown>;
  stopWatcher(watcherId: string): Promise<unknown>;
}

export function sentinelData(bridge?: any, http?: typeof fetch): SentinelData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getWatchers(): Promise<Watcher[]> {
      if (typeof window !== "undefined" && (window as any).__testWatchers !== undefined) {
        return (window as any).__testWatchers;
      }
      const b = getBridge();
      if (b?.getWatchers) {
        try {
          const res = await b.getWatchers();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/sentinels") : await fetch("/api/sentinels");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async getSentinelLogs(watcherId?: string): Promise<SentinelLog[]> {
      if (typeof window !== "undefined" && (window as any).__testSentinelLogs !== undefined) {
        return (window as any).__testSentinelLogs;
      }
      const b = getBridge();
      if (b?.getSentinelLogs) {
        try {
          const res = await b.getSentinelLogs(watcherId);
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const query = watcherId ? `?watcherId=${encodeURIComponent(watcherId)}` : "";
        const res = http ? await http(`/api/sentinels/logs${query}`) : await fetch(`/api/sentinels/logs${query}`);
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async startWatcher(payload: CreateWatcherInput): Promise<unknown> {
      const b = getBridge();
      if (b?.startWatcher) {
        try {
          return await b.startWatcher(payload);
        } catch {
          // fall through to the HTTP route
        }
      }
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
      const res = http ? await http("/api/sentinels", init) : await fetch("/api/sentinels", init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not start watcher (HTTP ${res.status})`);
      return data;
    },

    async stopWatcher(watcherId: string): Promise<unknown> {
      const b = getBridge();
      if (b?.stopWatcher) {
        try {
          return await b.stopWatcher(watcherId);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/sentinels/${encodeURIComponent(watcherId)}`, { method: "DELETE" })
        : await fetch(`/api/sentinels/${encodeURIComponent(watcherId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not stop watcher (HTTP ${res.status})`);
      }
      return res.json().catch(() => ({}));
    },
  };
}
