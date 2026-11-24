import type { Connector, ConnectorTestResult } from "../../../src/shell/connectors-model";

export interface ConnectorsData {
  getConnectors(): Promise<Connector[]>;
  getConnector(id: string): Promise<Connector | null>;
  connectApp(id: string, data?: { token?: string; account?: string }): Promise<{ authUrl?: string; [key: string]: unknown }>;
  disconnectApp(id: string): Promise<unknown>;
  testConnector(id: string): Promise<ConnectorTestResult>;
}

export function connectorsData(bridge?: any, http?: typeof fetch): ConnectorsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  const request = (url: string, init?: RequestInit) => (http ? http(url, init) : fetch(url, init));
  const post = (path: string, body?: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const fail = (res: Response, fallback: string): never => {
    // `res.json()` is deliberately not awaited for opaque/error bodies.
    throw new Error(fallback + ` (HTTP ${res.status})`);
  };
  return {
    async getConnectors(): Promise<Connector[]> {
      if (typeof window !== "undefined" && (window as any).__testConnectors !== undefined) {
        return (window as any).__testConnectors;
      }
      const b = getBridge();
      if (b?.getConnectors) {
        try {
          const res = await b.getConnectors();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = await request("/api/connectors");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async getConnector(id: string): Promise<Connector | null> {
      const b = getBridge();
      if (b?.getConnector) {
        try {
          const res = await b.getConnector(id);
          if (res && typeof res === "object") return res as Connector;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = await request(`/api/connectors/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        return (await res.json()) as Connector;
      } catch {
        return null;
      }
    },

    async connectApp(id: string, data?: { token?: string; account?: string }): Promise<{ authUrl?: string; [key: string]: unknown }> {
      const b = getBridge();
      if (b?.connectApp) {
        try {
          return await b.connectApp(id, data || {});
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await request(`/api/connectors/${encodeURIComponent(id)}/connect`, post("/connect", data || {}));
      if (!res.ok) fail(res, "Could not connect");
      return (await res.json().catch(() => ({}))) as { authUrl?: string };
    },

    async disconnectApp(id: string): Promise<unknown> {
      const b = getBridge();
      if (b?.disconnectApp) {
        try {
          return await b.disconnectApp(id);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await request(`/api/connectors/${encodeURIComponent(id)}/disconnect`, post("/disconnect"));
      if (!res.ok) fail(res, "Could not disconnect");
      return res.json().catch(() => ({}));
    },

    async testConnector(id: string): Promise<ConnectorTestResult> {
      const b = getBridge();
      if (b?.testConnector) {
        try {
          return await b.testConnector(id);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await request(`/api/connectors/${encodeURIComponent(id)}/test`, post("/test"));
      if (!res.ok) fail(res, "Could not test connection");
      return (await res.json().catch(() => ({}))) as ConnectorTestResult;
    },
  };
}
