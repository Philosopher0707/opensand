import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { AgentTemplate } from "./types.js";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
  /** Whether this agent may run turns. New agents start disabled until enabled. */
  enabled?: boolean;
  /** Inline SVG avatar for the sidebar/details logo; absent = default avatar. */
  logoSvg?: string;
  /** Hex accent color tinting the logo paths. */
  logoColor?: string;
  /** Sampling temperature (0-2). Absent = model default. */
  temperature?: number;
  /** Maximum output tokens per turn. Absent = model default. */
  maxTokens?: number;
  /** Nucleus sampling probability (0-1). Absent = model default. */
  topP?: number;
  /** Vault reference id for the provider API key; raw key never travels on wire. */
  openRouterApiKeyId?: string;
  /** Epoch ms when the key was last validated. */
  lastValidatedAt?: number;
  /** Last validation error message, if any. */
  validationError?: string | null;
  /** Predicted session outcome (set by user). */
  predictedOutcome?: "positive" | "negative" | "uncertain" | "pending";
  /** Observed session outcome (set after turn completes). */
  observedOutcome?: "positive" | "negative" | "uncertain" | "pending";
  /** Standing instructions — the persona body (the "soul"). */
  soul?: string;
  /** sha256 of soul, for spotting a SOUL.md edited outside the app. */
  soulHash?: string;
  /** Stored avatar image URL (file:// or served); null when none. */
  avatarUrl?: string | null;
  /** Approval mode for tool calls: "ask" (prompt each time), "custom" (alwaysAllow list), "allow" (auto-approve). */
  approvalMode?: "ask" | "custom" | "allow";
  /** Auto-approve tool calls without prompting. */
  autoApprove?: boolean;
  /** Tools this agent may always use without asking (when approvalMode === "custom"). */
  alwaysAllow?: string[];
  /** Optional labeled divider used to organize this agent in the sidebar. */
  section?: string;
  /** The coordinator for this agent's sidebar section. */
  chiefOfStaff?: boolean;
  /** Owner-selected additional sections this Chief may coordinate. */
  managedSections?: string[];
  /** Team member email who created this agent (Team Cloud only). */
  createdBy?: string;
  /** Member email this agent reports to (Team Cloud only). */
  reportsTo?: string;
  /** Who may see this agent: "everyone" | "admins" | { people: string[] }. */
  visibility?: "everyone" | "admins" | { people: string[] };
  /** This agent's own voice id. */
  voice?: string;
  /** Speak this agent's replies aloud as they settle. */
  speakReplies?: boolean;
  /** Whether this agent may send voice notes. */
  voiceNotes?: boolean;
  /** How replies are shaped. Absent = "default". */
  replyStyle?: "default" | "concise" | "detailed";
  /** Newest-first list of this agent's threads/tasks. Transient, reset on load. */
  tasks?: AgentTask[];
  /** Currently active thread id. */
  threadId?: string;
  /** Where a routine without its own thread reports. */
  mainThreadId?: string;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  logoSvg?: string;
  logoColor?: string;
  soul?: string;
  avatarUrl?: string | null;
  approvalMode?: "ask" | "custom" | "allow";
  autoApprove?: boolean;
  alwaysAllow?: string[];
  section?: string;
  chiefOfStaff?: boolean;
  managedSections?: string[];
  createdBy?: string;
  reportsTo?: string;
  visibility?: "everyone" | "admins" | { people: string[] };
  voice?: string;
  speakReplies?: boolean;
  voiceNotes?: boolean;
  replyStyle?: "default" | "concise" | "detailed";
}

/** One task (thread) belonging to an agent. */
export interface AgentTask {
  id: string;
  threadId: string;
  title: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  agentId?: string;
  pinned: boolean;
  unread: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

/** Body for creating a new task/thread for an agent. */
export interface CreateAgentTaskInput {
  threadId: string;
  title: string;
  status?: "todo" | "in_progress" | "done" | "blocked";
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

/** Fields allowed to be patched on an existing agent's profile. */
export interface UpdateAgentProfileInput {
  name?: string;
  role?: string;
  systemPrompt?: string;
  soul?: string;
  avatarUrl?: string | null;
}

/** A snapshot of an agent's profile fields at a point in time. */
export interface AgentProfileSnapshot {
  name: string;
  role: string;
  systemPrompt: string;
  soul?: string;
  soulHash?: string;
}

/** One recorded profile change (audit log entry). */
export interface AgentProfileChange {
  id: string;
  agentId: string;
  changedBy: "user" | "system" | "import";
  source: string;
  before: AgentProfileSnapshot;
  after: AgentProfileSnapshot;
  at: number;
}

/** Fields allowed to be patched on an existing agent's settings. */
export interface UpdateAgentSettingsInput {
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  logoSvg?: string;
  logoColor?: string;
  predictedOutcome?: "positive" | "negative" | "uncertain" | "pending";
  observedOutcome?: "positive" | "negative" | "uncertain" | "pending";
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
      kind: input.kind ?? "AGENT",
      model: input.model,
      endpoint: input.endpoint,
      allowedTools: input.allowedTools,
      soul: input.soul,
      avatarUrl: input.avatarUrl ?? null,
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

  /** Patch settings fields on an existing agent. */
  async updateAgentSettings(idOrName: string, updates: UpdateAgentSettingsInput): Promise<AgentRecord> {
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

  /** Patch approval-mode fields on an existing agent. */
  async updateAgentApproval(idOrName: string, updates: { approvalMode?: "ask" | "custom" | "allow"; autoApprove?: boolean; alwaysAllow?: string[] }): Promise<AgentRecord> {
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

  /** Patch section/team fields on an existing agent. */
  async updateAgentSection(idOrName: string, updates: { section?: string; chiefOfStaff?: boolean; managedSections?: string[]; createdBy?: string; reportsTo?: string; visibility?: "everyone" | "admins" | { people: string[] } }): Promise<AgentRecord> {
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

  /** Patch voice fields on an existing agent. */
  async updateAgentVoice(idOrName: string, updates: { voice?: string; speakReplies?: boolean; voiceNotes?: boolean; replyStyle?: "default" | "concise" | "detailed" }): Promise<AgentRecord> {
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

  /** Create a new task/thread for an agent. */
  async createAgentTask(agentIdOrName: string, input: CreateAgentTaskInput): Promise<AgentTask> {
    const agent = await this.getAgent(agentIdOrName);
    if (!agent) {
      throw new Error(`Agent [${agentIdOrName}] not found in store`);
    }

    const task: AgentTask = {
      id: `task_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      threadId: input.threadId,
      title: input.title,
      status: input.status ?? "todo",
      agentId: agent.id,
      pinned: input.pinned ?? false,
      unread: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: input.metadata,
    };

    const updated: AgentRecord = {
      ...agent,
      tasks: [...(agent.tasks ?? []), task],
      threadId: input.threadId,
      updatedAt: Date.now(),
    };

    await this.saveRecordAtomic(updated);
    return task;
  }

  /** Switch an agent's active thread. */
  async switchAgentThread(agentIdOrName: string, threadId: string): Promise<AgentRecord> {
    const agent = await this.getAgent(agentIdOrName);
    if (!agent) {
      throw new Error(`Agent [${agentIdOrName}] not found in store`);
    }

    const task = agent.tasks?.find((t) => t.threadId === threadId);
    if (!task) {
      throw new Error(`Thread [${threadId}] not found for agent [${agentIdOrName}]`);
    }

    const updated: AgentRecord = {
      ...agent,
      threadId,
      updatedAt: Date.now(),
    };

    await this.saveRecordAtomic(updated);
    return updated;
  }

  /** List tasks for an agent. */
  async listAgentTasks(agentIdOrName: string): Promise<AgentTask[]> {
    const agent = await this.getAgent(agentIdOrName);
    if (!agent) return [];
    return [...(agent.tasks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Patch profile fields (name/role/systemPrompt/soul) and compute soulHash. */
  async updateAgentProfile(idOrName: string, updates: UpdateAgentProfileInput): Promise<AgentRecord> {
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
      soulHash: updates.soul !== undefined ? crypto.createHash("sha256").update(updates.soul).digest("hex") : existing.soulHash,
    };

    await this.saveRecordAtomic(updated);
    return updated;
  }

  /** Record a profile change audit entry. */
  async recordProfileChange(
    agentId: string,
    changedBy: AgentProfileChange["changedBy"],
    source: string,
    before: AgentProfileSnapshot,
    after: AgentProfileSnapshot
  ): Promise<AgentProfileChange> {
    const change: AgentProfileChange = {
      id: `profile_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      agentId,
      changedBy,
      source,
      before,
      after,
      at: Date.now(),
    };

    const changeDir = path.join(this.baseDir, "profile-changes");
    await fs.mkdir(changeDir, { recursive: true, mode: 0o700 });
    const changePath = path.join(changeDir, `${change.id}.json`);
    await fs.writeFile(changePath, JSON.stringify(change, null, 2), { mode: 0o600 });
    return change;
  }

  /** List profile change audit entries for an agent. */
  async listProfileChanges(agentId: string): Promise<AgentProfileChange[]> {
    const changeDir = path.join(this.baseDir, "profile-changes");
    try {
      const files = await fs.readdir(changeDir);
      const changes: AgentProfileChange[] = [];
      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        try {
          const raw = await fs.readFile(path.join(changeDir, file), "utf-8");
          const change = JSON.parse(raw) as AgentProfileChange;
          if (change && change.agentId === agentId) changes.push(change);
        } catch {
          // Skip corrupted
        }
      }
      return changes.sort((a, b) => b.at - a.at);
    } catch {
      return [];
    }
  }

  /**
   * Export an agent definition into a portable Grok Bot template (GrokBotTemplate parity).
   */
  async exportTemplate(idOrName: string): Promise<AgentTemplate> {
    const agent = await this.getAgent(idOrName);
    if (!agent) {
      throw new Error(`Agent [${idOrName}] not found in store`);
    }

    return {
      templateVersion: "1.0.0",
      name: agent.name,
      role: agent.role,
      description: typeof agent.metadata?.description === "string" ? agent.metadata.description : undefined,
      systemPrompt: agent.systemPrompt,
      kind: agent.kind,
      model: agent.model,
      endpoint: agent.endpoint,
      allowedTools: agent.allowedTools,
      metadata: agent.metadata,
      exportedAtMs: Date.now(),
    };
  }

  /**
   * Import a portable agent template into a registered bot persona (GrokBotTemplate parity).
   */
  async importTemplate(templateInput: AgentTemplate | string): Promise<AgentRecord> {
    const template: AgentTemplate =
      typeof templateInput === "string" ? JSON.parse(templateInput) : templateInput;

    if (!template.name || !template.role || !template.systemPrompt) {
      throw new Error("Invalid agent template: missing 'name', 'role', or 'systemPrompt'");
    }

    return this.createAgent({
      name: template.name,
      role: template.role,
      systemPrompt: template.systemPrompt,
      kind: template.kind ?? "AGENT",
      model: template.model,
      endpoint: template.endpoint,
      allowedTools: template.allowedTools,
      metadata: {
        ...(template.metadata ?? {}),
        importedFromTemplate: true,
        templateVersion: template.templateVersion || "1.0.0",
      },
    });
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
