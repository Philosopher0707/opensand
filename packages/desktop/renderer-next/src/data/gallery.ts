import type { GalleryTemplate } from "../../../src/shell/gallery-model";

export interface PublishGalleryInput {
  id: string;
  name: string;
  role?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  category: string;
  tags: string[];
  author: string;
  description: string;
}

export interface GalleryData {
  getGalleryTemplates(params?: { category?: string; query?: string }): Promise<GalleryTemplate[]>;
  getGalleryTemplate(id: string): Promise<GalleryTemplate | null>;
  installGalleryTemplate(id: string): Promise<{ agent?: unknown; [key: string]: unknown }>;
  publishGalleryTemplate(payload: PublishGalleryInput): Promise<unknown>;
}

export function galleryData(bridge?: any, http?: typeof fetch): GalleryData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  const request = (url: string, init?: RequestInit) => (http ? http(url, init) : fetch(url, init));
  return {
    async getGalleryTemplates(params?: { category?: string; query?: string }): Promise<GalleryTemplate[]> {
      if (typeof window !== "undefined" && (window as any).__testGalleryTemplates !== undefined) {
        const hook = (window as any).__testGalleryTemplates;
        return typeof hook === "function" ? hook(params || {}) : hook;
      }
      const b = getBridge();
      if (b?.getGalleryTemplates) {
        try {
          const res = await b.getGalleryTemplates(params || {});
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const q = new URLSearchParams();
        if (params?.category && params.category !== "all") q.set("category", params.category);
        if (params?.query) q.set("query", params.query);
        const qs = q.toString() ? `?${q.toString()}` : "";
        const res = await request(`/api/gallery/templates${qs}`);
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async getGalleryTemplate(id: string): Promise<GalleryTemplate | null> {
      const b = getBridge();
      if (b?.getGalleryTemplate) {
        try {
          const res = await b.getGalleryTemplate(id);
          if (res && typeof res === "object") return res as GalleryTemplate;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = await request(`/api/gallery/templates/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },

    async installGalleryTemplate(id: string): Promise<{ agent?: unknown; [key: string]: unknown }> {
      const b = getBridge();
      if (b?.installGalleryTemplate) {
        try {
          return await b.installGalleryTemplate(id);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await request(`/api/gallery/templates/${encodeURIComponent(id)}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not install template (HTTP ${res.status})`);
      return data;
    },

    async publishGalleryTemplate(payload: PublishGalleryInput): Promise<unknown> {
      const b = getBridge();
      if (b?.publishGalleryTemplate) {
        try {
          return await b.publishGalleryTemplate(payload);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await request("/api/gallery/templates/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not publish template (HTTP ${res.status})`);
      return data;
    },
  };
}
