import type { BtwAnswer, RollbackResult, CompactResult } from "../../../src/shell/session-actions-model";

export interface SessionActionsData {
  askBtw(question: string): Promise<BtwAnswer>;
  rollbackTurns(turns: number): Promise<RollbackResult>;
  compactHistory(keepRecentTurns: number): Promise<CompactResult>;
}

export function sessionActionsData(bridge?: any, http?: typeof fetch): SessionActionsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  const request = (url: string, body: unknown) => {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    return (http ? http(url, init) : fetch(url, init));
  };
  const post = async <T,>(url: string, body: unknown, bridgeMethod: string | undefined, args: unknown[]): Promise<T> => {
    const b = getBridge();
    if (bridgeMethod && b?.[bridgeMethod]) {
      try {
        return await b[bridgeMethod](...args);
      } catch {
        // fall through to the HTTP route
      }
    }
    const res = await request(url, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
    return data as T;
  };
  return {
    askBtw(question: string): Promise<BtwAnswer> {
      return post<BtwAnswer>("/api/btw", { question }, "askBtw", [question]);
    },
    rollbackTurns(turns: number): Promise<RollbackResult> {
      return post<RollbackResult>("/api/rollback", { turns }, "rollbackTurns", [turns]);
    },
    compactHistory(keepRecentTurns: number): Promise<CompactResult> {
      return post<CompactResult>("/api/compact", { keepRecentTurns }, "compactHistory", [keepRecentTurns]);
    },
  };
}
