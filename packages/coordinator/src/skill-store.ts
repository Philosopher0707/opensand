import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { AgentStore } from "./agent-store.js";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  category?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
  category?: string;
}

export class SkillStore {
  private baseDir: string;
  private agentStore?: AgentStore;

  constructor(options?: { baseDir?: string; agentStore?: AgentStore }) {
    this.baseDir = options?.baseDir ?? path.join(os.homedir(), ".opensand", "skills");
    this.agentStore = options?.agentStore;
  }

  get storageDirectory(): string {
    return this.baseDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
  }

  async createSkill(input: CreateSkillInput): Promise<SkillRecord> {
    await this.ensureDirectory();

    const slug = this.slugify(input.name) || "skill";
    const existing = await this.getSkill(input.name);
    const id = existing?.id ?? `skill_${slug}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();

    const record: SkillRecord = {
      id,
      name: input.name.trim(),
      description: input.description.trim(),
      content: input.content.trim(),
      category: input.category?.trim() || "general",
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    await this.saveSkillAtomic(record);
    return record;
  }

  async getSkill(idOrName: string): Promise<SkillRecord | null> {
    const all = await this.listSkills();
    const query = idOrName.toLowerCase().trim();

    return (
      all.find(
        (s) => s.id.toLowerCase() === query || s.name.toLowerCase() === query
      ) ?? null
    );
  }

  async listSkills(category?: string): Promise<SkillRecord[]> {
    await this.ensureDirectory();

    try {
      const files = await fs.readdir(this.baseDir);
      const skills: SkillRecord[] = [];

      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        try {
          const raw = await fs.readFile(path.join(this.baseDir, file), "utf-8");
          const item = JSON.parse(raw) as SkillRecord;
          if (item && item.id && item.name) {
            if (!category || item.category === category) {
              skills.push(item);
            }
          }
        } catch {
          // Skip corrupted files
        }
      }

      return skills.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    } catch {
      return [];
    }
  }

  async updateSkill(idOrName: string, updates: Partial<CreateSkillInput>): Promise<SkillRecord> {
    const existing = await this.getSkill(idOrName);
    if (!existing) {
      throw new Error(`Skill '${idOrName}' not found`);
    }

    const updated: SkillRecord = {
      ...existing,
      name: updates.name ? updates.name.trim() : existing.name,
      description: updates.description !== undefined ? updates.description.trim() : existing.description,
      content: updates.content !== undefined ? updates.content.trim() : existing.content,
      category: updates.category !== undefined ? updates.category.trim() : existing.category,
      updatedAtMs: Date.now(),
    };

    await this.saveSkillAtomic(updated);
    return updated;
  }

  async deleteSkill(idOrName: string): Promise<boolean> {
    const existing = await this.getSkill(idOrName);
    if (!existing) return false;

    const filePath = path.join(this.baseDir, `${existing.id}.json`);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // --- Agent Mounting API (Grok Bot Parity: AddGrokBotAgentSkill / RemoveGrokBotAgentSkill) ---

  async mountSkillToAgent(agentIdOrName: string, skillIdOrName: string): Promise<{ agentId: string; mountedSkills: string[] }> {
    if (!this.agentStore) {
      throw new Error("AgentStore not configured on SkillStore");
    }

    const agent = await this.agentStore.getAgent(agentIdOrName);
    if (!agent) {
      throw new Error(`Agent '${agentIdOrName}' not found`);
    }

    const skill = await this.getSkill(skillIdOrName);
    if (!skill) {
      throw new Error(`Skill '${skillIdOrName}' not found`);
    }

    const metadata = agent.metadata ?? {};
    const mounted: string[] = Array.isArray(metadata.skills) ? [...metadata.skills] : [];

    if (!mounted.includes(skill.id)) {
      mounted.push(skill.id);
      await this.agentStore.updateAgent(agent.id, {
        metadata: {
          ...metadata,
          skills: mounted,
        },
      });
    }

    return { agentId: agent.id, mountedSkills: mounted };
  }

  async unmountSkillFromAgent(agentIdOrName: string, skillIdOrName: string): Promise<{ agentId: string; mountedSkills: string[] }> {
    if (!this.agentStore) {
      throw new Error("AgentStore not configured on SkillStore");
    }

    const agent = await this.agentStore.getAgent(agentIdOrName);
    if (!agent) {
      throw new Error(`Agent '${agentIdOrName}' not found`);
    }

    const skill = await this.getSkill(skillIdOrName);
    if (!skill) {
      throw new Error(`Skill '${skillIdOrName}' not found`);
    }

    const metadata = agent.metadata ?? {};
    let mounted: string[] = Array.isArray(metadata.skills) ? [...metadata.skills] : [];

    mounted = mounted.filter((sId) => sId !== skill.id);
    await this.agentStore.updateAgent(agent.id, {
      metadata: {
        ...metadata,
        skills: mounted,
      },
    });

    return { agentId: agent.id, mountedSkills: mounted };
  }

  async getAgentSkills(agentIdOrName: string): Promise<SkillRecord[]> {
    if (!this.agentStore) return [];

    const agent = await this.agentStore.getAgent(agentIdOrName);
    if (!agent) return [];

    const skillIds: string[] = Array.isArray(agent.metadata?.skills) ? agent.metadata!.skills : [];
    const all = await this.listSkills();

    return all.filter((s) => skillIds.includes(s.id));
  }

  async formatSkillsPrompt(agentIdOrName: string): Promise<string> {
    const skills = await this.getAgentSkills(agentIdOrName);
    if (skills.length === 0) return "";

    let prompt = "## Active Agent Skills\n";
    for (const s of skills) {
      prompt += `\n### Skill: ${s.name}\n${s.description ? `*${s.description}*\n` : ""}\n${s.content}\n`;
    }
    return prompt.trim();
  }

  private async saveSkillAtomic(record: SkillRecord): Promise<void> {
    const targetPath = path.join(this.baseDir, `${record.id}.json`);
    const tempPath = path.join(this.baseDir, `.${record.id}.${Date.now()}.tmp`);

    await fs.writeFile(tempPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    await fs.rename(tempPath, targetPath);
  }
}
