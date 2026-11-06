import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export type VaultItemKind = "API_KEY" | "PASSWORD" | "TOKEN" | "SSH_KEY" | "CERTIFICATE" | "OTHER";
export type VaultItemManager = "LOCAL" | "ONE_PASSWORD" | "SYSTEM_KEYCHAIN";

export interface VaultSecret {
  id: string;
  name: string;
  description: string;
  value: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface VaultCredential {
  id: string;
  title: string;
  username: string;
  password?: string;
  notes?: string;
  sites: string[];
  agentId?: string;
  kind: VaultItemKind;
  managedBy: VaultItemManager;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PutSecretInput {
  name: string;
  value: string;
  description?: string;
}

export interface PutCredentialInput {
  title: string;
  username: string;
  password?: string;
  notes?: string;
  sites?: string[];
  agentId?: string;
  kind?: VaultItemKind;
  managedBy?: VaultItemManager;
}

interface EncryptedVaultContainer {
  version: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface PlainVaultPayload {
  secrets: Record<string, VaultSecret>;
  credentials: Record<string, VaultCredential>;
}

export class VaultStore {
  private baseDir: string;
  private vaultFilePath: string;
  private saltFilePath: string;
  private masterKeyFilePath: string;
  private passphrase?: string;
  private knownSecretValues = new Map<string, string>(); // secret value -> secret name
  private initialized = false;

  constructor(options?: { baseDir?: string; passphrase?: string }) {
    this.baseDir = options?.baseDir ?? path.join(os.homedir(), ".opensand", "vault");
    this.vaultFilePath = path.join(this.baseDir, "vault.enc");
    this.saltFilePath = path.join(this.baseDir, ".vault.salt");
    this.masterKeyFilePath = path.join(this.baseDir, ".vault.key");
    this.passphrase = options?.passphrase ?? process.env.OPENSAND_VAULT_PASSPHRASE;
  }

  get storageDirectory(): string {
    return this.baseDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private getOrCreateSaltSync(): Buffer {
    try {
      const raw = fsSync.readFileSync(this.saltFilePath);
      if (raw.length === 32) {
        return raw;
      }
    } catch {
      // File missing or invalid
    }

    const salt = crypto.randomBytes(32);
    try {
      fsSync.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
      fsSync.writeFileSync(this.saltFilePath, salt, { mode: 0o600 });
    } catch {
      // Best-effort write
    }
    return salt;
  }

  private getOrCreateMasterKeySync(): Buffer {
    try {
      const raw = fsSync.readFileSync(this.masterKeyFilePath);
      if (raw.length === 32) {
        return raw;
      }
    } catch {
      // File missing or invalid
    }

    const key = crypto.randomBytes(32);
    try {
      fsSync.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
      fsSync.writeFileSync(this.masterKeyFilePath, key, { mode: 0o600 });
    } catch {
      // Best-effort write
    }
    return key;
  }

  private deriveKeySync(): Buffer {
    const salt = this.getOrCreateSaltSync();
    if (this.passphrase) {
      return crypto.pbkdf2Sync(this.passphrase, salt, 100_000, 32, "sha256");
    }
    const masterKey = this.getOrCreateMasterKeySync();
    return crypto.pbkdf2Sync(masterKey, salt, 100_000, 32, "sha256");
  }

  public getSecretSync(nameOrId: string): VaultSecret | null {
    try {
      if (!fsSync.existsSync(this.vaultFilePath)) return null;
      const raw = fsSync.readFileSync(this.vaultFilePath, "utf-8");
      const container: EncryptedVaultContainer = JSON.parse(raw);

      let key = this.deriveKeySync();
      let decrypted: string | null = null;

      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(container.iv, "hex"));
        decipher.setAuthTag(Buffer.from(container.tag, "hex"));
        let dec = decipher.update(container.ciphertext, "hex", "utf-8");
        dec += decipher.final("utf-8");
        decrypted = dec;
      } catch {
        if (!this.passphrase) {
          const salt = this.getOrCreateSaltSync();
          const legacySeed = `${os.hostname()}:${os.userInfo().username}:${os.homedir()}:opensand-default-vault-seed`;
          const legacyKey = crypto.pbkdf2Sync(legacySeed, salt, 100_000, 32, "sha256");
          const legacyDecipher = crypto.createDecipheriv("aes-256-gcm", legacyKey, Buffer.from(container.iv, "hex"));
          legacyDecipher.setAuthTag(Buffer.from(container.tag, "hex"));
          let dec = legacyDecipher.update(container.ciphertext, "hex", "utf-8");
          dec += legacyDecipher.final("utf-8");
          decrypted = dec;
        }
      }

      if (!decrypted) return null;
      const payload = JSON.parse(decrypted) as PlainVaultPayload;
      const query = nameOrId.toLowerCase().trim();
      return (
        Object.values(payload.secrets).find(
          (s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private async getOrCreateSalt(): Promise<Buffer> {
    try {
      const raw = await fs.readFile(this.saltFilePath);
      if (raw.length === 32) {
        return raw;
      }
    } catch {
      // File missing or invalid
    }

    const salt = crypto.randomBytes(32);
    await fs.writeFile(this.saltFilePath, salt, { mode: 0o600 });
    return salt;
  }

  private async getOrCreateMasterKey(): Promise<Buffer> {
    try {
      const raw = await fs.readFile(this.masterKeyFilePath);
      if (raw.length === 32) {
        return raw;
      }
    } catch {
      // File missing or invalid
    }

    const key = crypto.randomBytes(32);
    await fs.writeFile(this.masterKeyFilePath, key, { mode: 0o600 });
    return key;
  }

  private async deriveKey(): Promise<Buffer> {
    const salt = await this.getOrCreateSalt();
    if (this.passphrase) {
      return crypto.pbkdf2Sync(this.passphrase, salt, 100_000, 32, "sha256");
    }
    const masterKey = await this.getOrCreateMasterKey();
    return crypto.pbkdf2Sync(masterKey, salt, 100_000, 32, "sha256");
  }

  private async loadPayload(): Promise<PlainVaultPayload> {
    await this.ensureDirectory();

    try {
      const raw = await fs.readFile(this.vaultFilePath, "utf-8");
      const container: EncryptedVaultContainer = JSON.parse(raw);

      let decrypted: string | null = null;
      let key = await this.deriveKey();

      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(container.iv, "hex"));
        decipher.setAuthTag(Buffer.from(container.tag, "hex"));

        let dec = decipher.update(container.ciphertext, "hex", "utf-8");
        dec += decipher.final("utf-8");
        decrypted = dec;
      } catch (decryptErr) {
        // Fallback check: if no explicit passphrase was set, attempt legacy machine-seed decryption for seamless migration
        if (!this.passphrase) {
          const salt = await this.getOrCreateSalt();
          const legacySeed = `${os.hostname()}:${os.userInfo().username}:${os.homedir()}:opensand-default-vault-seed`;
          const legacyKey = crypto.pbkdf2Sync(legacySeed, salt, 100_000, 32, "sha256");
          const legacyDecipher = crypto.createDecipheriv("aes-256-gcm", legacyKey, Buffer.from(container.iv, "hex"));
          legacyDecipher.setAuthTag(Buffer.from(container.tag, "hex"));

          let dec = legacyDecipher.update(container.ciphertext, "hex", "utf-8");
          dec += legacyDecipher.final("utf-8");
          decrypted = dec;

          // Migrate vault file to newly generated authentic random master key
          const payload = JSON.parse(decrypted) as PlainVaultPayload;
          await this.savePayloadAtomic(payload);
          return payload;
        }
        throw decryptErr;
      }

      const payload = JSON.parse(decrypted) as PlainVaultPayload;
      this.rebuildKnownSecrets(payload);
      return payload;
    } catch {
      // Vault does not exist or empty
      const emptyPayload: PlainVaultPayload = { secrets: {}, credentials: {} };
      this.rebuildKnownSecrets(emptyPayload);
      return emptyPayload;
    }
  }

  private rebuildKnownSecrets(payload: PlainVaultPayload): void {
    this.knownSecretValues.clear();
    for (const sec of Object.values(payload.secrets)) {
      if (sec.value && sec.value.length >= 6) {
        this.knownSecretValues.set(sec.value, sec.name);
      }
    }
    for (const cred of Object.values(payload.credentials)) {
      if (cred.password && cred.password.length >= 6) {
        this.knownSecretValues.set(cred.password, cred.title);
      }
    }
  }

  private async savePayloadAtomic(payload: PlainVaultPayload): Promise<void> {
    await this.ensureDirectory();
    this.rebuildKnownSecrets(payload);

    const key = await this.deriveKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const serialized = JSON.stringify(payload);
    let ciphertext = cipher.update(serialized, "utf-8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");

    const salt = (await this.getOrCreateSalt()).toString("hex");
    const container: EncryptedVaultContainer = {
      version: 1,
      salt,
      iv: iv.toString("hex"),
      tag,
      ciphertext,
    };

    const tempPath = path.join(this.baseDir, `.vault.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
    await fs.writeFile(tempPath, JSON.stringify(container, null, 2), { mode: 0o600 });
    await fs.rename(tempPath, this.vaultFilePath);
  }

  // --- Secrets API ---

  async putSecret(input: PutSecretInput): Promise<VaultSecret> {
    const payload = await this.loadPayload();
    const name = input.name.trim();
    if (!name) throw new Error("Secret name cannot be empty");

    const existingKey = Object.keys(payload.secrets).find((k) => k.toLowerCase() === name.toLowerCase());
    const id = existingKey ?? `sec_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();

    const record: VaultSecret = {
      id,
      name,
      description: input.description ?? "",
      value: input.value,
      createdAtMs: payload.secrets[id]?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    payload.secrets[id] = record;
    await this.savePayloadAtomic(payload);
    return record;
  }

  async getSecret(nameOrId: string): Promise<VaultSecret | null> {
    const payload = await this.loadPayload();
    const query = nameOrId.toLowerCase().trim();

    const found = Object.values(payload.secrets).find(
      (s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query
    );
    return found ?? null;
  }

  async listSecrets(): Promise<Array<Omit<VaultSecret, "value"> & { hasValue: boolean; preview: string }>> {
    const payload = await this.loadPayload();
    return Object.values(payload.secrets)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        createdAtMs: s.createdAtMs,
        updatedAtMs: s.updatedAtMs,
        hasValue: Boolean(s.value),
        preview: s.value ? `${s.value.slice(0, 3)}...${s.value.slice(-3)}` : "",
      }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async deleteSecret(nameOrId: string): Promise<boolean> {
    const payload = await this.loadPayload();
    const query = nameOrId.toLowerCase().trim();

    const key = Object.keys(payload.secrets).find(
      (k) => payload.secrets[k].id.toLowerCase() === query || payload.secrets[k].name.toLowerCase() === query
    );

    if (key) {
      delete payload.secrets[key];
      await this.savePayloadAtomic(payload);
      return true;
    }
    return false;
  }

  // --- Credentials API ---

  async putCredential(input: PutCredentialInput): Promise<VaultCredential> {
    const payload = await this.loadPayload();
    const title = input.title.trim();
    if (!title) throw new Error("Credential title cannot be empty");

    const existingKey = Object.keys(payload.credentials).find(
      (k) => payload.credentials[k].title.toLowerCase() === title.toLowerCase() &&
             payload.credentials[k].username.toLowerCase() === input.username.toLowerCase()
    );
    const id = existingKey ?? `cred_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();

    const record: VaultCredential = {
      id,
      title,
      username: input.username,
      password: input.password,
      notes: input.notes,
      sites: input.sites ?? [],
      agentId: input.agentId,
      kind: input.kind ?? "API_KEY",
      managedBy: input.managedBy ?? "LOCAL",
      createdAtMs: payload.credentials[id]?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    payload.credentials[id] = record;
    await this.savePayloadAtomic(payload);
    return record;
  }

  async getCredential(idOrTitle: string): Promise<VaultCredential | null> {
    const payload = await this.loadPayload();
    const query = idOrTitle.toLowerCase().trim();

    return (
      Object.values(payload.credentials).find(
        (c) => c.id.toLowerCase() === query || c.title.toLowerCase() === query
      ) ?? null
    );
  }

  async listCredentials(filter?: {
    kind?: VaultItemKind;
    agentId?: string;
  }): Promise<Array<Omit<VaultCredential, "password"> & { hasPassword: boolean }>> {
    const payload = await this.loadPayload();
    let list = Object.values(payload.credentials);

    if (filter?.kind) {
      list = list.filter((c) => c.kind === filter.kind);
    }
    if (filter?.agentId) {
      list = list.filter((c) => c.agentId === filter.agentId);
    }

    return list
      .map((c) => ({
        id: c.id,
        title: c.title,
        username: c.username,
        notes: c.notes,
        sites: c.sites,
        agentId: c.agentId,
        kind: c.kind,
        managedBy: c.managedBy,
        createdAtMs: c.createdAtMs,
        updatedAtMs: c.updatedAtMs,
        hasPassword: Boolean(c.password),
      }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async deleteCredential(idOrTitle: string): Promise<boolean> {
    const payload = await this.loadPayload();
    const query = idOrTitle.toLowerCase().trim();

    const key = Object.keys(payload.credentials).find(
      (k) => payload.credentials[k].id.toLowerCase() === query || payload.credentials[k].title.toLowerCase() === query
    );

    if (key) {
      delete payload.credentials[key];
      await this.savePayloadAtomic(payload);
      return true;
    }
    return false;
  }

  // --- Automatic Redaction / Scrubbing Engine ---

  redactText(text: string): string {
    if (!text || this.knownSecretValues.size === 0) return text;
    let redacted = text;

    for (const [secretVal, secretName] of this.knownSecretValues.entries()) {
      if (secretVal.length >= 6 && redacted.includes(secretVal)) {
        const replacement = `[REDACTED_VAULT_SECRET:${secretName}]`;
        redacted = redacted.split(secretVal).join(replacement);
      }
    }

    return redacted;
  }
}
