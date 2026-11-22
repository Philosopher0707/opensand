import type { CreateMemoryInput, MemoryFact, ReviewItem } from "../../../src/shell/memories-model";

export interface MemoriesData {
  getMemories(tier?: string, scope?: string): Promise<MemoryFact[]>;
  addMemory(payload: CreateMemoryInput): Promise<MemoryFact>;
  forgetMemory(id: string, scope?: string): Promise<void>;
  deleteMemory(id: string, scope?: string): Promise<void>;
  getTeamReviewItems(): Promise<ReviewItem[]>;
  resolveReviewItem(itemId: string, decision: "approve" | "reject"): Promise<unknown>;
}

export function memoriesData(bridge?: any, http?: typeof fetch): MemoriesData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getMemories(tier?: string, scope?: string): Promise<MemoryFact[]> {
      if (typeof window !== "undefined" && (window as any).__testMemories !== undefined) {
        let list: MemoryFact[] = (window as any).__testMemories;
        if (tier) list = list.filter((m) => m.tier === tier);
        if (scope) list = list.filter((m) => m.scope === scope);
        return list;
      }
      const b = getBridge();
      if (b?.getMemories) {
        try {
          const res = await b.getMemories(tier, scope);
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to HTTP route
        }
      }
      if (b?.listMemories) {
        try {
          const res = await b.listMemories({ tier, scope });
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to HTTP route
        }
      }
      try {
        const params = new URLSearchParams();
        if (tier) params.set("tier", tier);
        if (scope) params.set("scope", scope);
        const qs = params.toString() ? `?${params.toString()}` : "";
        const res = http ? await http(`/api/memories${qs}`) : await fetch(`/api/memories${qs}`);
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return [];
    },

    async addMemory(payload: CreateMemoryInput): Promise<MemoryFact> {
      const b = getBridge();
      if (b?.addMemory) {
        try {
          return await b.addMemory(payload);
        } catch {
          // fall through to HTTP route
        }
      }
      const res = http
        ? await http("/api/memories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/memories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not add memory (HTTP ${res.status})`);
      return data as MemoryFact;
    },

    async forgetMemory(id: string, scope?: string): Promise<void> {
      const b = getBridge();
      if (b?.forgetMemory) {
        try {
          await b.forgetMemory(id, scope);
          return;
        } catch {
          // fall through to HTTP route
        }
      }
      const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      const res = http
        ? await http(`/api/memories/${encodeURIComponent(id)}${qs}`, { method: "DELETE" })
        : await fetch(`/api/memories/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not forget memory (HTTP ${res.status})`);
      }
    },

    async deleteMemory(id: string, scope?: string): Promise<void> {
      return this.forgetMemory(id, scope);
    },

    async getTeamReviewItems(): Promise<ReviewItem[]> {
      if (typeof window !== "undefined" && (window as any).__testReviewItems !== undefined) {
        return (window as any).__testReviewItems;
      }
      const b = getBridge();
      if (b?.getTeamReviewItems) {
        try {
          const res = await b.getTeamReviewItems();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to HTTP route
        }
      }
      if (b?.listReviewItems) {
        try {
          const res = await b.listReviewItems();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to HTTP route
        }
      }
      try {
        const res = http ? await http("/api/team-review") : await fetch("/api/team-review");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when fetch route is not available
      }
      return [];
    },

    async resolveReviewItem(itemId: string, decision: "approve" | "reject"): Promise<unknown> {
      const b = getBridge();
      if (b?.resolveReviewItem) {
        try {
          return await b.resolveReviewItem(itemId, decision);
        } catch {
          // fall through to HTTP route
        }
      }
      const res = http
        ? await http("/api/team-review/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId, decision }),
          })
        : await fetch("/api/team-review/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId, decision }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not resolve review item (HTTP ${res.status})`);
      return data;
    },
  };
}
