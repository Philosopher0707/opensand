import type { Webhook, WebhookDelivery, CreateWebhookInput } from "../../../src/shell/webhooks-model";

export interface WebhooksData {
  getWebhooks(): Promise<Webhook[]>;
  getWebhookDeliveries(): Promise<WebhookDelivery[]>;
  createWebhook(payload: CreateWebhookInput): Promise<unknown>;
  deleteWebhook(name: string): Promise<unknown>;
}

export function webhooksData(bridge?: any, http?: typeof fetch): WebhooksData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getWebhooks(): Promise<Webhook[]> {
      if (typeof window !== "undefined" && (window as any).__testWebhooks !== undefined) {
        return (window as any).__testWebhooks;
      }
      const b = getBridge();
      if (b?.getWebhooks) {
        try {
          const res = await b.getWebhooks();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/webhooks") : await fetch("/api/webhooks");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async getWebhookDeliveries(): Promise<WebhookDelivery[]> {
      if (typeof window !== "undefined" && (window as any).__testWebhookDeliveries !== undefined) {
        return (window as any).__testWebhookDeliveries;
      }
      const b = getBridge();
      if (b?.getWebhookDeliveries) {
        try {
          const res = await b.getWebhookDeliveries();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/webhooks/deliveries") : await fetch("/api/webhooks/deliveries");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createWebhook(payload: CreateWebhookInput): Promise<unknown> {
      const b = getBridge();
      if (b?.createWebhook) {
        try {
          return await b.createWebhook(payload);
        } catch {
          // fall through to the HTTP route
        }
      }
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
      const res = http ? await http("/api/webhooks", init) : await fetch("/api/webhooks", init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not create webhook (HTTP ${res.status})`);
      return data;
    },

    async deleteWebhook(name: string): Promise<unknown> {
      const b = getBridge();
      if (b?.deleteWebhook) {
        try {
          return await b.deleteWebhook(name);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/webhooks/${encodeURIComponent(name)}`, { method: "DELETE" })
        : await fetch(`/api/webhooks/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not delete webhook (HTTP ${res.status})`);
      }
      return res.json().catch(() => ({}));
    },
  };
}
