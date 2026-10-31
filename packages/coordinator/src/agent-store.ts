import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt: string;
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
}

export class AgentStore {
  private baseDir: string;

  constructor(customDir?: string) {
    this.baseDir = customDir ?? path.join(os.homedir(), ".opensand", "agents");
  }

  get storageDirectory(): string {
    return this.baseDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    await this.ensureDirectory();

    const slug = this.slugify(input.name) || "agent";
    const rand = crypto.randomBytes(4).toString("hex");
    const id = `agent_${slug}_${rand}`;
    const now = Date.now();

    const record: AgentRecord = {
      id,
      name: input.name,
      role: input.role,
      systemPrompt: input.systemPrompt,
      model: input.model,
      endpoint: input.endpoint,
      allowedTools: input.allowedTools,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    await this.saveRecordAtomic(record);
    return record;
  }

  async getAgent(idOrName: string): Promise<AgentRecord | null> {
    const all = await this.listAgents();
    const query = idOrName.toLowerCase().trim();

    // 1. Match by exact ID
    const byId = all.find((a) => a.id.toLowerCase() === query);
    if (byId) return byId;

    // 2. Match by exact Name
    const byName = all.find((a) => a.name.toLowerCase() === query);
    if (byName) return byName;

    // 3. Match by partial/slug
    return all.find((a) => a.id.includes(query) || a.name.toLowerCase().includes(query)) ?? null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    await this.ensureDirectory();

    try {
      const files = await fs.readdir(this.baseDir);
      const records: AgentRecord[] = [];

      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;

        try {
          const filePath = path.join(this.baseDir, file);
          const raw = await fs.readFile(filePath, "utf-8");
          const record = JSON.parse(raw) as AgentRecord;
          if (record && record.id && record.name) {
            records.push(record);
          }
        } catch {
          // Skip corrupted files
        }
      }

      return records.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  async updateAgent(idOrName: string, updates: Partial<CreateAgentInput>): Promise<AgentRecord> {
    const existing = await this.getAgent(idOrName);
    if (!existing) {
      throw new Error(`Agent [${idOrName}] not found in store`);
    }

    const updated: AgentRecord = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };

    await this.saveRecordAtomic(updated);
    return updated;
  }

  async deleteAgent(idOrName: string): Promise<boolean> {
    const existing = await this.getAgent(idOrName);
    if (!existing) return false;

    const filePath = path.join(this.baseDir, `${existing.id}.json`);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async saveRecordAtomic(record: AgentRecord): Promise<void> {
    const targetPath = path.join(this.baseDir, `${record.id}.json`);
    const tempPath = path.join(this.baseDir, `.${record.id}.${Date.now()}.tmp`);
    const content = JSON.stringify(record, null, 2);

    try {
      await fs.writeFile(tempPath, content, { mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}
