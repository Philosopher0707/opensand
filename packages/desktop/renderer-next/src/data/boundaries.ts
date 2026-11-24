import type { PolicyRule, PolicyAuditEntry, CreateRuleInput } from "../../../src/shell/boundaries-model";

export interface BoundariesData {
  getPolicies(): Promise<PolicyRule[]>;
  getPolicyAudit(): Promise<PolicyAuditEntry[]>;
  createPolicy(rule: CreateRuleInput): Promise<unknown>;
  deletePolicy(id: string): Promise<unknown>;
}

export function boundariesData(bridge?: any, http?: typeof fetch): BoundariesData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getPolicies(): Promise<PolicyRule[]> {
      if (typeof window !== "undefined" && (window as any).__testPolicies !== undefined) {
        return (window as any).__testPolicies;
      }
      const b = getBridge();
      if (b?.getPolicies) {
        try {
          const res = await b.getPolicies();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/policies") : await fetch("/api/policies");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async getPolicyAudit(): Promise<PolicyAuditEntry[]> {
      if (typeof window !== "undefined" && (window as any).__testPolicyAudit !== undefined) {
        return (window as any).__testPolicyAudit;
      }
      const b = getBridge();
      if (b?.getPolicyAudit) {
        try {
          const res = await b.getPolicyAudit();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/policies/audit") : await fetch("/api/policies/audit");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createPolicy(rule: CreateRuleInput): Promise<unknown> {
      const b = getBridge();
      if (b?.createPolicy) {
        try {
          return await b.createPolicy(rule);
        } catch {
          // fall through to the HTTP route
        }
      }
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      };
      const res = http ? await http("/api/policies", init) : await fetch("/api/policies", init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not create rule (HTTP ${res.status})`);
      return data;
    },

    async deletePolicy(id: string): Promise<unknown> {
      const b = getBridge();
      if (b?.deletePolicy) {
        try {
          return await b.deletePolicy(id);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/policies/${encodeURIComponent(id)}`, { method: "DELETE" })
        : await fetch(`/api/policies/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not delete rule (HTTP ${res.status})`);
      }
      return res.json().catch(() => ({}));
    },
  };
}
