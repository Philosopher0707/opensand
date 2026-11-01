import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { AgentStore } from "./agent-store.js";

/**
 * Clean-room parity with Grok Bot's Skill Architecture:
 * - SKILL.md file structure with YAML frontmatter (name, description, origin, upload-name)
 * - Size limit: 256 KB per skill (256e3)
 * - Bot limit: 250 skills max per agent (MAX_BOT_SKILLS = 250)
 * - Dynamic prompt injection and mounting
 */

export const MAX_SKILL_SIZE_BYTES = 256 * 1024; // 256 KB
export const MAX_BOT_SKILLS = 250;

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  category?: string;
  origin?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
  category?: string;
  origin?: string;
}

export interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  body: string;
  hasFrontmatter: boolean;
}

/**
 * Pure standard YAML frontmatter parser (1:1 parity with Grok Bot's nq and OOt parser)
 */
export function parseSkillContent(rawContent: string): ParsedSkillFrontmatter {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
  const match = frontmatterRegex.exec(rawContent);

  if (!match) {
    // Extract first H1 heading if present: # Heading
    const firstLine = rawContent.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    const h1Match = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(firstLine);
    return {
      name: h1Match?.[1]?.trim(),
      description: undefined,
      body: rawContent,
      hasFrontmatter: false,
    };
  }

  const frontmatterText = match[1];
  const body = rawContent.slice(match[0].length);

  const extractField = (key: string): string | undefined => {
    const prefix = `${key}:`;
    const line = frontmatterText.split(/\r?\n/).find((l) => l.trim().startsWith(prefix));
    if (!line) return undefined;
    let val = line.trim().slice(prefix.length).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    return val || undefined;
  };

  return {
    name: extractField("name"),
    description: extractField("description"),
    body,
    hasFrontmatter: true,
  };
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

    const rawContent = input.content.trim();
    if (Buffer.byteLength(rawContent, "utf8") > MAX_SKILL_SIZE_BYTES) {
      throw new Error(`Skill content exceeds maximum allowed size of 256 KB (${MAX_SKILL_SIZE_BYTES} bytes)`);
    }

    // Parse frontmatter if present
    const parsed = parseSkillContent(rawContent);

    const finalName = (input.name.trim() || parsed.name || "Untitled Skill").trim();
    const finalDescription = (input.description.trim() || parsed.description || "").trim();
    // Keep raw content or extracted body for prompt consumption
    const finalContent = rawContent;

    const slug = this.slugify(finalName) || "skill";
    const existing = await this.getSkill(finalName);
    const id = existing?.id ?? `skill_${slug}_${crypto.randomBytes(4).toString("hex")}`;
    const now = Date.now();

    const record: SkillRecord = {
      id,
      name: finalName,
      description: finalDescription,
      content: finalContent,
      category: input.category?.trim() || "general",
      origin: input.origin ?? (parsed.hasFrontmatter ? "frontmatter" : "custom"),
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    };

    await this.saveSkillAtomic(record);
    return record;
  }

  /**
   * Import a skill directly from a SKILL.md or text file on disk
   */
  async importSkillFromFile(filePath: string, category?: string): Promise<SkillRecord> {
    const raw = await fs.readFile(filePath, "utf-8");
    const basename = path.basename(filePath);
    const parentDirName = path.basename(path.dirname(filePath));

    // Parity with Grok Bot's U(e): if filename is SKILL.md, infer name from directory
    const defaultName = basename.toLowerCase() === "skill.md" ? parentDirName : path.parse(basename).name;

    const parsed = parseSkillContent(raw);
    const name = parsed.name || defaultName;
    const description = parsed.description || "";

    return this.createSkill({
      name,
      description,
      content: raw,
      category: category || "imported",
      origin: "file",
    });
  }

  /**
   * Discover and import all SKILL.md files from a folder (e.g. .cursor/skills-cursor/ or .opensand/skills/)
   */
  async importSkillsFromDirectory(dirPath: string, category?: string): Promise<SkillRecord[]> {
    const imported: SkillRecord[] = [];

    const walk = async (currDir: string) => {
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
      try {
        entries = await fs.readdir(currDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(currDir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && (entry.name.toLowerCase() === "skill.md" || entry.name.endsWith(".md"))) {
          try {
            const skill = await this.importSkillFromFile(full, category);
            imported.push(skill);
          } catch {
            // Skip invalid/oversized
          }
        }
      }
    };

    await walk(dirPath);
    return imported;
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
      if (mounted.length >= MAX_BOT_SKILLS) {
        throw new Error(`Agent '${agentIdOrName}' has reached the maximum of ${MAX_BOT_SKILLS} mounted skills`);
      }
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
