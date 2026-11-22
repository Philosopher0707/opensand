import type {
  VaultSecret,
  VaultCredential,
  SecretInput,
  CredentialInput,
} from "../../../src/shell/vault-model";

export interface VaultData {
  getSecrets(): Promise<VaultSecret[]>;
  createSecret(input: SecretInput): Promise<void>;
  deleteSecret(id: string): Promise<void>;
  getCredentials(): Promise<VaultCredential[]>;
  createCredential(input: CredentialInput): Promise<void>;
  deleteCredential(id: string): Promise<void>;
}

// Copy only display metadata at the boundary. `preview` is derived from the stored value by
// vault-store.ts, and `value`/`password` may be present in a response: neither reaches the page.
function toSecret(raw: any): VaultSecret {
  return {
    id: String(raw?.id ?? raw?.name ?? ""),
    name: String(raw?.name ?? ""),
    description: raw?.description ? String(raw.description) : undefined,
  };
}

function toCredential(raw: any): VaultCredential {
  return {
    id: String(raw?.id ?? raw?.title ?? ""),
    title: String(raw?.title ?? ""),
    username: raw?.username ? String(raw.username) : undefined,
    sites: Array.isArray(raw?.sites) ? raw.sites.map(String) : undefined,
  };
}

export function vaultData(bridge?: any, http?: typeof fetch): VaultData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  const getTestVault = () => (typeof window !== "undefined" ? (window as any).__testVault : undefined);
  const call = (url: string, init?: RequestInit) =>
    http ? http(url, init) : fetch(url, init);
  const post = (url: string, body: unknown) =>
    call(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const errorFrom = async (res: Response, fallback: string) => {
    const data = await res.json().catch(() => ({}));
    return new Error(data?.error || `${fallback} (HTTP ${res.status})`);
  };

  return {
    async getSecrets(): Promise<VaultSecret[]> {
      const test = getTestVault();
      if (test) return Array.isArray(test.secrets) ? test.secrets.map(toSecret) : [];
      const b = getBridge();
      if (b?.listSecrets) {
        try {
          const res = await b.listSecrets();
          if (Array.isArray(res)) return res.map(toSecret);
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = await call("/api/vault/secrets");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data.map(toSecret) : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createSecret(input: SecretInput): Promise<void> {
      const test = getTestVault();
      const body = {
        name: input.name.trim(),
        value: input.value.trim(),
        description: input.description?.trim() || "",
      };
      if (test) {
        test.secrets = [...(Array.isArray(test.secrets) ? test.secrets : []), { id: `sec_${(test.secrets?.length ?? 0) + 1}`, ...body }];
        return;
      }
      const b = getBridge();
      if (b?.putSecret) {
        try {
          await b.putSecret(body);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await post("/api/vault/secrets", body);
      if (!res.ok) throw await errorFrom(res, "Could not store secret");
    },

    async deleteSecret(id: string): Promise<void> {
      const test = getTestVault();
      if (test) {
        test.secrets = (test.secrets || []).filter((s: any) => s.id !== id && s.name !== id);
        return;
      }
      const b = getBridge();
      if (b?.deleteSecret) {
        try {
          await b.deleteSecret(id);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await call(`/api/vault/secrets/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw await errorFrom(res, "Could not delete secret");
    },

    async getCredentials(): Promise<VaultCredential[]> {
      const test = getTestVault();
      if (test) return Array.isArray(test.credentials) ? test.credentials.map(toCredential) : [];
      const b = getBridge();
      if (b?.listCredentials) {
        try {
          const res = await b.listCredentials();
          if (Array.isArray(res)) return res.map(toCredential);
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = await call("/api/vault/credentials");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data.map(toCredential) : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createCredential(input: CredentialInput): Promise<void> {
      const test = getTestVault();
      const body = {
        title: input.title.trim(),
        username: input.username.trim(),
        password: input.password?.trim() || "",
        sites: input.sites ?? [],
      };
      if (test) {
        test.credentials = [...(Array.isArray(test.credentials) ? test.credentials : []), { id: `cred_${(test.credentials?.length ?? 0) + 1}`, ...body }];
        return;
      }
      const b = getBridge();
      if (b?.putCredential) {
        try {
          await b.putCredential(body);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await post("/api/vault/credentials", body);
      if (!res.ok) throw await errorFrom(res, "Could not store credential");
    },

    async deleteCredential(id: string): Promise<void> {
      const test = getTestVault();
      if (test) {
        test.credentials = (test.credentials || []).filter((c: any) => c.id !== id && c.title !== id);
        return;
      }
      const b = getBridge();
      if (b?.deleteCredential) {
        try {
          await b.deleteCredential(id);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = await call(`/api/vault/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw await errorFrom(res, "Could not delete credential");
    },
  };
}
