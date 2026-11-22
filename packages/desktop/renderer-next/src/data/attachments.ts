import type { Attachment } from "../../../src/shell/attachments-model";

export interface AttachmentsData {
  getAttachments(): Promise<Attachment[]>;
  stageAttachment(filePath: string): Promise<{ id: string } | null>;
  deleteAttachment(id: string): Promise<void>;
}

export function attachmentsData(bridge?: any, http?: typeof fetch): AttachmentsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  const getMock = (): Attachment[] | undefined =>
    typeof window !== "undefined" && Array.isArray((window as any).__testAttachments)
      ? (window as any).__testAttachments
      : undefined;
  return {
    async getAttachments(): Promise<Attachment[]> {
      const mock = getMock();
      if (mock) return mock;
      const b = getBridge();
      if (b?.listAttachments) {
        try {
          const res = await b.listAttachments();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      if (b?.getAttachments) {
        try {
          const res = await b.getAttachments();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/attachments") : await fetch("/api/attachments");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async stageAttachment(filePath: string): Promise<{ id: string } | null> {
      const mock = getMock();
      if (mock) {
        const path = String(filePath || "").trim();
        if (!path) throw new Error("Missing filePath");
        const att: Attachment = {
          id: `att_${mock.length + 1}`,
          filename: path.split(/[\\/]/).pop() || "Attachment",
          localPath: path,
          sizeBytes: 0,
          mimeType: "application/octet-stream",
          sha256: "",
        };
        (window as any).__testAttachments = [...mock, att];
        return { id: att.id };
      }
      const b = getBridge();
      if (b?.stageAttachment) {
        try {
          const res = await b.stageAttachment(filePath);
          return res && res.id ? { id: res.id } : null;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http("/api/attachments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath }),
          })
        : await fetch("/api/attachments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not stage attachment (HTTP ${res.status})`);
      return data as { id: string };
    },

    async deleteAttachment(id: string): Promise<void> {
      const mock = getMock();
      if (mock) {
        (window as any).__testAttachments = mock.filter((a) => a.id !== id);
        return;
      }
      const b = getBridge();
      if (b?.deleteAttachment) {
        try {
          await b.deleteAttachment(id);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" })
        : await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not unstage attachment (HTTP ${res.status})`);
      }
    },
  };
}
