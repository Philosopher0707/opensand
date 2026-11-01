import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";

export type MemoryScope = "user" | "agent" | "team";
export type MemoryTier = "profile" | "log";
export type ReviewItemStatus = "pending" | "approved" | "rejected";
export type ReviewAction = "write" | "forget";

export interface MemoryFact {
  factId: string;
  text: string;
  learnedAtMs: number;
  scope: MemoryScope;
  tier: MemoryTier;
  agentId?: string;
}

export interface TeamReviewChange {
  action: ReviewAction;
  memoryType: MemoryTier;
  text: string;
  metaJson?: string;
  path?: string;
}

export interface TeamReviewItem {
  itemId: string;
  status: ReviewItemStatus;
  proposedBy: string;
  reviewedBy?: string;
  createdAtMs: number;
  reviewedAtMs?: number;
  change: TeamReviewChange;
}

export interface TeamContextSummary {
  memoryVersion: number;
  generatedAtMs: number;
  prose: string;
  summaryModel: string;
}

export interface MemoryStoreOptions {
  baseDir?: string;
}

export class MemoryStore {
  private baseDir: string;

  constructor(options: MemoryStoreOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.homedir(), ".opensand", "memories");
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  private getFilePath(scope: MemoryScope, agentId?: string): string {
    if (scope === "team") {
      return path.join(this.baseDir, "team-memories.json");
    }
    if (scope === "agent" && agentId) {
      const sanitized = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
      return path.join(this.baseDir, `agent-${sanitized}-memories.json`);
    }
    return path.join(this.baseDir, "user-memories.json");
  }

  private getReviewQueuePath(): string {
    return path.join(this.baseDir, "team-review-items.json");
  }

  private getSummaryPath(): string {
    return path.join(this.baseDir, "team-context-summary.json");
  }

  private async readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJsonAtomic<T>(filePath: string, data: T): Promise<void> {
    await this.ensureDir();
    const tmpPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, payload, { mode: 0o600, encoding: "utf-8" });
    await fs.rename(tmpPath, filePath);
  }

  /**
   * Add a new discrete memory fact.
   */
  async addMemory(fact: {
    text: string;
    scope?: MemoryScope;
    tier?: MemoryTier;
    agentId?: string;
  }): Promise<MemoryFact> {
    const scope = fact.scope ?? "user";
    const tier = fact.tier ?? "log";
    const filePath = this.getFilePath(scope, fact.agentId);

    const data = await this.readJsonSafe<{ memories: MemoryFact[] }>(filePath, { memories: [] });
    const factId = `fact_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const newFact: MemoryFact = {
      factId,
      text: fact.text.trim(),
      learnedAtMs: Date.now(),
      scope,
      tier,
      agentId: fact.agentId,
    };

    data.memories.push(newFact);
    await this.writeJsonAtomic(filePath, data);

    return newFact;
  }

  /**
   * List memory facts matching scope, tier, agent, and search query.
   */
  async listMemories(filter: {
    scope?: MemoryScope | "all";
    tier?: MemoryTier | "all";
    agentId?: string;
    query?: string;
  } = {}): Promise<MemoryFact[]> {
    await this.ensureDir();
    const scopesToRead: Array<{ scope: MemoryScope; agentId?: string }> = [];

    const targetScope = filter.scope ?? "all";
    if (targetScope === "all") {
      scopesToRead.push({ scope: "user" });
      scopesToRead.push({ scope: "team" });
      if (filter.agentId) {
        scopesToRead.push({ scope: "agent", agentId: filter.agentId });
      }
    } else if (targetScope === "agent") {
      scopesToRead.push({ scope: "agent", agentId: filter.agentId });
    } else {
      scopesToRead.push({ scope: targetScope });
    }

    let all: MemoryFact[] = [];
    for (const item of scopesToRead) {
      const p = this.getFilePath(item.scope, item.agentId);
      const data = await this.readJsonSafe<{ memories: MemoryFact[] }>(p, { memories: [] });
      all.push(...data.memories);
    }

    // Filter by tier
    if (filter.tier && filter.tier !== "all") {
      all = all.filter((m) => m.tier === filter.tier);
    }

    // Filter by text query
    if (filter.query && filter.query.trim()) {
      const q = filter.query.toLowerCase().trim();
      all = all.filter((m) => m.text.toLowerCase().includes(q));
    }

    // Sort by learnedAtMs ascending (oldest first, Grok Bot parity)
    all.sort((a, b) => a.learnedAtMs - b.learnedAtMs);
    return all;
  }

  /**
   * Delete / forget a memory fact by ID.
   */
  async forgetMemory(factId: string, scope?: MemoryScope, agentId?: string): Promise<boolean> {
    const scopesToCheck: Array<{ scope: MemoryScope; agentId?: string }> = scope
      ? [{ scope, agentId }]
      : [{ scope: "user" }, { scope: "team" }, ...(agentId ? [{ scope: "agent" as MemoryScope, agentId }] : [])];

    for (const item of scopesToCheck) {
      const p = this.getFilePath(item.scope, item.agentId);
      const data = await this.readJsonSafe<{ memories: MemoryFact[] }>(p, { memories: [] });
      const initialCount = data.memories.length;
      data.memories = data.memories.filter((m) => m.factId !== factId);
      if (data.memories.length !== initialCount) {
        await this.writeJsonAtomic(p, data);
        return true;
      }
    }
    return false;
  }

  /**
   * Promote user memory facts to the shared team memory pool (Grok Bot parity).
   */
  async promoteMemoriesToTeam(
    agentId: string,
    factIds: string[]
  ): Promise<{
    created: MemoryFact[];
    alreadyInTeam: MemoryFact[];
    keptPrivateCount: number;
  }> {
    const userMemories = await this.listMemories({ scope: "user" });
    const teamMemoriesPath = this.getFilePath("team");
    const teamData = await this.readJsonSafe<{ memories: MemoryFact[] }>(teamMemoriesPath, { memories: [] });

    const created: MemoryFact[] = [];
    const alreadyInTeam: MemoryFact[] = [];
    const selectedIds = new Set(factIds);

    for (const uFact of userMemories) {
      if (!selectedIds.has(uFact.factId)) continue;

      const exists = teamData.memories.find((tm) => tm.text.toLowerCase() === uFact.text.toLowerCase());
      if (exists) {
        alreadyInTeam.push(exists);
      } else {
        const teamFact: MemoryFact = {
          factId: `team_fact_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
          text: uFact.text,
          learnedAtMs: Date.now(),
          scope: "team",
          tier: uFact.tier,
          agentId,
        };
        teamData.memories.push(teamFact);
        created.push(teamFact);
      }
    }

    if (created.length > 0) {
      await this.writeJsonAtomic(teamMemoriesPath, teamData);
    }

    const keptPrivateCount = userMemories.length - (created.length + alreadyInTeam.length);
    return {
      created,
      alreadyInTeam,
      keptPrivateCount: Math.max(0, keptPrivateCount),
    };
  }

  /**
   * Get team context summary with prose synthesis (Grok Bot GetGrokBotTeamContextSummary parity).
   */
  async getTeamContextSummary(agentId?: string): Promise<{
    learned: MemoryFact[];
    memoryCount: number;
    prose: string;
    memoryVersion: number;
  }> {
    const teamFacts = await this.listMemories({ scope: "team" });
    const summaryData = await this.readJsonSafe<TeamContextSummary>(this.getSummaryPath(), {
      memoryVersion: 1,
      generatedAtMs: Date.now(),
      prose: teamFacts.map((f) => `- ${f.text}`).join("\n") || "No shared team facts established yet.",
      summaryModel: "local-synthesizer",
    });

    return {
      learned: teamFacts,
      memoryCount: teamFacts.length,
      prose: summaryData.prose,
      memoryVersion: summaryData.memoryVersion,
    };
  }

  /**
   * Update the team natural language prose summary.
   */
  async updateTeamContextSummary(prose: string, summaryModel = "local-synthesizer"): Promise<void> {
    const current = await this.readJsonSafe<TeamContextSummary>(this.getSummaryPath(), {
      memoryVersion: 1,
      generatedAtMs: 0,
      prose: "",
      summaryModel: "",
    });

    const updated: TeamContextSummary = {
      memoryVersion: current.memoryVersion + 1,
      generatedAtMs: Date.now(),
      prose: prose.trim(),
      summaryModel,
    };

    await this.writeJsonAtomic(this.getSummaryPath(), updated);
  }

  /**
   * Add an item to the team consensus review queue (Grok Bot GrokBotTeamReviewItem parity).
   */
  async addReviewItem(proposal: {
    proposedBy: string;
    change: TeamReviewChange;
  }): Promise<TeamReviewItem> {
    const qPath = this.getReviewQueuePath();
    const data = await this.readJsonSafe<{ items: TeamReviewItem[] }>(qPath, { items: [] });

    const item: TeamReviewItem = {
      itemId: `rev_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      status: "pending",
      proposedBy: proposal.proposedBy,
      createdAtMs: Date.now(),
      change: proposal.change,
    };

    data.items.push(item);
    await this.writeJsonAtomic(qPath, data);
    return item;
  }

  /**
   * List items from the team consensus review queue.
   */
  async listReviewItems(filter: {
    status?: ReviewItemStatus;
    limit?: number;
  } = {}): Promise<TeamReviewItem[]> {
    const qPath = this.getReviewQueuePath();
    const data = await this.readJsonSafe<{ items: TeamReviewItem[] }>(qPath, { items: [] });
    let items = data.items;

    if (filter.status) {
      items = items.filter((i) => i.status === filter.status);
    }

    items.sort((a, b) => b.createdAtMs - a.createdAtMs);

    if (filter.limit && filter.limit > 0) {
      items = items.slice(0, filter.limit);
    }

    return items;
  }

  /**
   * Resolve an item in the team consensus review queue.
   * If approved and change is 'write', automatically commits the memory to team store!
   * If approved and change is 'forget', expunges matching memory from team store!
   */
  async resolveReviewItem(
    itemId: string,
    decision: "approve" | "reject",
    reviewerId = "human_operator"
  ): Promise<TeamReviewItem> {
    const qPath = this.getReviewQueuePath();
    const data = await this.readJsonSafe<{ items: TeamReviewItem[] }>(qPath, { items: [] });
    const item = data.items.find((i) => i.itemId === itemId);

    if (!item) {
      throw new Error(`Team review item [${itemId}] not found.`);
    }

    item.status = decision === "approve" ? "approved" : "rejected";
    item.reviewedBy = reviewerId;
    item.reviewedAtMs = Date.now();

    await this.writeJsonAtomic(qPath, data);

    // Apply the approved change to team memory
    if (decision === "approve") {
      if (item.change.action === "write") {
        await this.addMemory({
          text: item.change.text,
          scope: "team",
          tier: item.change.memoryType,
        });
      } else if (item.change.action === "forget") {
        const teamMemories = await this.listMemories({ scope: "team" });
        const match = teamMemories.find((m) => m.text.toLowerCase() === item.change.text.toLowerCase());
        if (match) {
          await this.forgetMemory(match.factId, "team");
        }
      }
    }

    return item;
  }

  /**
   * Import memories from external pasted exports (Grok Bot grok_bot_memory_import protocol parity).
   */
  async importMemoryText(
    exportedText: string,
    targetScope: MemoryScope = "user",
    agentId?: string
  ): Promise<{
    savedCount: number;
    skippedCount: number;
    facts: MemoryFact[];
  }> {
    const lines = exportedText.split("\n");
    let currentCategory = "Instructions";
    const existing = await this.listMemories({ scope: targetScope, agentId });
    const existingTexts = new Set(existing.map((e) => e.text.toLowerCase().trim()));

    const saved: MemoryFact[] = [];
    let skippedCount = 0;

    // Pattern matching sections (1. Instructions, 2. Identity, 3. Career, 4. Projects, 5. Preferences)
    const categoryRegex = /^\s*(?:[#*\d.\s-]+)?\b(Instructions|Identity|Career|Projects|Preferences)\b/i;
    // Pattern matching [YYYY-MM-DD] - Entry or [unknown] - Entry or standard bullet
    const entryRegex = /^\s*(?:[-*]\s*)?(?:\[([0-9\-_a-zA-Z]+)\]\s*[-:]?\s*)?(.*)$/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const catMatch = trimmed.match(categoryRegex);
      if (catMatch) {
        currentCategory = catMatch[1];
        continue;
      }

      // Check if this line is an actual memory entry
      const match = trimmed.match(entryRegex);
      if (!match) continue;

      let dateTag = match[1];
      let content = (match[2] || "").trim();

      // If content is empty or starts with markdown headers, skip
      if (!content || content.startsWith("#") || content.startsWith("**")) continue;

      // Filter out secrets
      const hasSecret = /(?:sk-[a-zA-Z0-9_-]{16,}|AKIA[0-9A-Z]{16}|password\s*=|Bearer\s+[a-zA-Z0-9_\-\.]+)/i.test(content);
      if (hasSecret) {
        skippedCount++;
        continue;
      }

      const formattedText = dateTag && dateTag.toLowerCase() !== "unknown"
        ? `[${dateTag}] - ${content}`
        : content;

      if (existingTexts.has(formattedText.toLowerCase())) {
        skippedCount++;
        continue;
      }

      // Instructions & Identity are profile tier; Career, Projects, Preferences are log tier
      const tier: MemoryTier = (currentCategory.toLowerCase() === "instructions" || currentCategory.toLowerCase() === "identity")
        ? "profile"
        : "log";

      const fact = await this.addMemory({
        text: formattedText,
        scope: targetScope,
        tier,
        agentId,
      });

      existingTexts.add(formattedText.toLowerCase());
      saved.push(fact);
    }

    return {
      savedCount: saved.length,
      skippedCount,
      facts: saved,
    };
  }

  /**
   * Format memory facts for system prompt injection.
   */
  async getPromptMemoryContext(agentId?: string): Promise<string> {
    const userProfileFacts = await this.listMemories({ scope: "user", tier: "profile" });
    const teamSummary = await this.getTeamContextSummary(agentId);
    let agentProfileFacts: MemoryFact[] = [];
    if (agentId) {
      agentProfileFacts = await this.listMemories({ scope: "agent", agentId, tier: "profile" });
    }

    const sections: string[] = [];

    if (userProfileFacts.length > 0) {
      sections.push("### User Profile & Preferences\n" + userProfileFacts.map((f) => `- ${f.text}`).join("\n"));
    }

    if (agentProfileFacts.length > 0) {
      sections.push("### Agent Persona Guidelines\n" + agentProfileFacts.map((f) => `- ${f.text}`).join("\n"));
    }

    if (teamSummary.memoryCount > 0) {
      sections.push(`### Shared Team Context (v${teamSummary.memoryVersion})\n${teamSummary.prose}`);
    }

    return sections.join("\n\n");
  }
}
