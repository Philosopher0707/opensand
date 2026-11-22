import type { Skill, CreateSkillInput } from "../../../src/shell/skills-model";

export interface SkillsData {
  getSkills(category?: string): Promise<Skill[]>;
  createSkill(payload: CreateSkillInput): Promise<Skill>;
  deleteSkill(skillId: string): Promise<void>;
}

export function skillsData(bridge?: any, http?: typeof fetch): SkillsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getSkills(category?: string): Promise<Skill[]> {
      if (typeof window !== "undefined" && (window as any).__testSkills !== undefined) {
        const list: Skill[] = (window as any).__testSkills;
        return category ? list.filter((s) => s.category === category) : list;
      }
      const b = getBridge();
      if (b?.getSkills) {
        try {
          const res = await b.getSkills(category);
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const query = category ? `?category=${encodeURIComponent(category)}` : "";
        const res = http ? await http(`/api/skills${query}`) : await fetch(`/api/skills${query}`);
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createSkill(payload: CreateSkillInput): Promise<Skill> {
      const b = getBridge();
      if (b?.createSkill) {
        try {
          return await b.createSkill(payload);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http("/api/skills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/skills", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not create skill (HTTP ${res.status})`);
      return data as Skill;
    },

    async deleteSkill(skillId: string): Promise<void> {
      const b = getBridge();
      if (b?.deleteSkill) {
        try {
          await b.deleteSkill(skillId);
          return;
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" })
        : await fetch(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Could not delete skill (HTTP ${res.status})`);
      }
    },
  };
}
