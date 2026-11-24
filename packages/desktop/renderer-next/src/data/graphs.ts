import type { AgentGraph, GraphRunResult, GraphTraceEvent } from "../../../src/shell/graphs-model";

export interface GraphsData {
  getGraphs(): Promise<AgentGraph[]>;
  runGraph(graphId: string, task?: string): Promise<GraphRunResult>;
}

export function graphsData(bridge?: any, http?: typeof fetch): GraphsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getGraphs(): Promise<AgentGraph[]> {
      if (typeof window !== "undefined" && (window as any).__testGraphs !== undefined) {
        return (window as any).__testGraphs;
      }
      const b = getBridge();
      if (b?.getGraphs) {
        try {
          const res = await b.getGraphs();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/graphs") : await fetch("/api/graphs");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async runGraph(graphId: string, task?: string): Promise<GraphRunResult> {
      const b = getBridge();
      if (b?.runGraph) {
        try {
          return await b.runGraph(graphId, task);
        } catch {
          // fall through to the HTTP route
        }
      }
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: task || "" }),
      };
      const res = http
        ? await http(`/api/graphs/${encodeURIComponent(graphId)}/run`, init)
        : await fetch(`/api/graphs/${encodeURIComponent(graphId)}/run`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not run graph (HTTP ${res.status})`);
      return data as GraphRunResult;
    },
  };
}
