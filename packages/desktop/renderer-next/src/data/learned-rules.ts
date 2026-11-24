import type { LearnedRules, LearnedRulesReport } from "../../../src/shell/learned-rules-model";

export interface LearnedRulesData {
  getLearnedRules(): Promise<LearnedRules>;
  refreshLearnedRules(): Promise<LearnedRulesReport>;
}

export function learnedRulesData(bridge?: any, http?: typeof fetch): LearnedRulesData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  const request = (url: string, init?: RequestInit) => (http ? http(url, init) : fetch(url, init));
  return {
    async getLearnedRules(): Promise<LearnedRules> {
      if (typeof window !== "undefined" && (window as any).__testLearnedRules !== undefined) {
        return (window as any).__testLearnedRules;
      }
      const b = getBridge();
      if (b?.getLearnedRules) {
        try {
          return await b.getLearnedRules();
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = await request("/api/learned-rules");
        if (res.ok) return await res.json();
      } catch {
        // Fallback when the fetch route is not available
      }
      return {};
    },

    async refreshLearnedRules(): Promise<LearnedRulesReport> {
      const b = getBridge();
      if (b?.refreshLearnedRules) {
        try {
          return await b.refreshLearnedRules();
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await request("/api/learned-rules/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`Could not refresh learned rules (HTTP ${res.status})`);
      return await res.json().catch(() => ({}));
    },
  };
}
