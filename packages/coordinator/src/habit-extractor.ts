import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface LearnedPreference {
  category: "workflow" | "tool_usage" | "formatting" | "correction";
  rule: string;
  evidence: string[];
  observedCount: number;
  lastUpdated: number;
}

export interface ExtractedHabitReport {
  totalTranscriptsAnalyzed: number;
  extractedQueriesCount: number;
  correctionsCount: number;
  rules: LearnedPreference[];
  markdownSummary: string;
}

export class HabitExtractor {
  private sessionsDir: string;
  private memoryFilePath: string;

  constructor(options?: { sessionsDir?: string; memoryFilePath?: string }) {
    this.sessionsDir = options?.sessionsDir ?? path.join(os.homedir(), ".opensand", "sessions");
    this.memoryFilePath = options?.memoryFilePath ?? path.join(os.homedir(), ".opensand", "learned_rules.md");
  }

  get storagePath(): string {
    return this.memoryFilePath;
  }

  async analyzeTranscripts(maxChatsToRead = 50): Promise<ExtractedHabitReport> {
    const rules: LearnedPreference[] = [];
    let totalTranscriptsAnalyzed = 0;
    let extractedQueriesCount = 0;
    let correctionsCount = 0;

    const queries: Array<{ text: string; sessionId: string; isCorrection: boolean }> = [];

    try {
      const sessionDirs = await fs.readdir(this.sessionsDir);
      const candidates: Array<{ dir: string; mtime: number }> = [];

      for (const dir of sessionDirs) {
        if (dir.startsWith(".")) continue;
        const transcriptPath = path.join(this.sessionsDir, dir, "transcript.txt");
        try {
          const stat = await fs.stat(transcriptPath);
          candidates.push({ dir, mtime: stat.mtimeMs });
        } catch {
          // No transcript.txt in this folder
        }
      }

      // Sort by newest first, take maxChatsToRead
      candidates.sort((a, b) => b.mtime - a.mtime);
      const targetDirs = candidates.slice(0, maxChatsToRead);
      totalTranscriptsAnalyzed = targetDirs.length;

      for (const { dir } of targetDirs) {
        const transcriptPath = path.join(this.sessionsDir, dir, "transcript.txt");
        const content = await fs.readFile(transcriptPath, "utf-8");

        // Extract <user_query>...</user_query>
        const queryRegex = /<user_query>([\s\S]*?)<\/user_query>/g;
        let match;
        while ((match = queryRegex.exec(content)) !== null) {
          const queryText = match[1].trim();
          if (!queryText) continue;
          extractedQueriesCount++;

          const isCorrection = this.isUserCorrection(queryText);
          if (isCorrection) correctionsCount++;

          queries.push({
            text: queryText,
            sessionId: dir,
            isCorrection,
          });
        }
      }

      // Aggregate repeated patterns & corrections
      const patternMap = new Map<string, { count: number; evidence: string[]; category: LearnedPreference["category"] }>();

      for (const q of queries) {
        const normalized = q.text.toLowerCase();

        // 1. Check for command preferences (pnpm vs npm, git commands, python/node)
        if (normalized.includes("pnpm")) {
          this.recordPattern(patternMap, "Always use pnpm instead of npm or yarn for package management", q.sessionId, "workflow");
        }
        if (normalized.includes("test") || normalized.includes("unit test") || normalized.includes("pnpm test")) {
          this.recordPattern(patternMap, "Verify changes with automated tests before completing tasks", q.sessionId, "workflow");
        }
        if (normalized.includes("local model") || normalized.includes("ollama")) {
          this.recordPattern(patternMap, "Prioritize local LLM execution and offline-compatible primitives", q.sessionId, "tool_usage");
        }
        if (normalized.includes("clean-room") || normalized.includes("no external dependencies")) {
          this.recordPattern(patternMap, "Maintain zero external runtime dependencies and native primitives", q.sessionId, "workflow");
        }

        // 2. Explicit corrections
        if (q.isCorrection) {
          if (normalized.includes("don't") || normalized.includes("do not") || normalized.includes("stop")) {
            this.recordPattern(patternMap, `User correction: Avoid unrequested manual actions without user approval`, q.sessionId, "correction");
          }
          if (normalized.includes("orchestrator") || normalized.includes("agent")) {
            this.recordPattern(patternMap, "Ensure multi-agent delegation is executed autonomously via Agent Orchestrator tools", q.sessionId, "correction");
          }
        }
      }

      const now = Date.now();
      for (const [rule, val] of patternMap.entries()) {
        rules.push({
          category: val.category,
          rule,
          evidence: Array.from(new Set(val.evidence)),
          observedCount: val.count,
          lastUpdated: now,
        });
      }

      // Generate Markdown Summary atomically via temp file
      const markdown = this.formatMarkdown(rules, totalTranscriptsAnalyzed, extractedQueriesCount, correctionsCount);
      const parentDir = path.dirname(this.memoryFilePath);
      await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
      const tempPath = path.join(parentDir, `.${path.basename(this.memoryFilePath)}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(tempPath, markdown, { encoding: "utf-8", mode: 0o600 });
        await fs.rename(tempPath, this.memoryFilePath);
      } catch (err) {
        await fs.unlink(tempPath).catch(() => {});
        throw err;
      }

      return {
        totalTranscriptsAnalyzed,
        extractedQueriesCount,
        correctionsCount,
        rules,
        markdownSummary: markdown,
      };
    } catch (err) {
      return {
        totalTranscriptsAnalyzed,
        extractedQueriesCount,
        correctionsCount,
        rules,
        markdownSummary: `# OpenSand Learned Rules\n\nNo prior transcripts available yet.\n`,
      };
    }
  }

  async getLearnedRulesMarkdown(): Promise<string> {
    try {
      return await fs.readFile(this.memoryFilePath, "utf-8");
    } catch {
      return "";
    }
  }

  private isUserCorrection(query: string): boolean {
    const q = query.toLowerCase();
    const correctionTriggers = [
      "no,",
      "no ",
      "don't",
      "do not",
      "stop",
      "undo",
      "that's wrong",
      "incorrect",
      "instead",
      "i asked you to",
      "not what i wanted",
      "hey this job is for",
    ];
    return correctionTriggers.some((t) => q.startsWith(t) || q.includes(t));
  }

  private recordPattern(
    map: Map<string, { count: number; evidence: string[]; category: LearnedPreference["category"] }>,
    rule: string,
    sessionId: string,
    category: LearnedPreference["category"]
  ): void {
    const existing = map.get(rule);
    if (existing) {
      existing.count++;
      existing.evidence.push(sessionId);
    } else {
      map.set(rule, { count: 1, evidence: [sessionId], category });
    }
  }

  private formatMarkdown(rules: LearnedPreference[], total: number, queries: number, corrections: number): string {
    const lines: string[] = [
      "# OpenSand Continuous Learning & User Guidelines",
      "",
      `> Extracted from ${total} sessions (${queries} queries, ${corrections} corrections) on ${new Date().toISOString()}`,
      "",
      "## Stable User Workflows & Preferences",
    ];

    if (rules.length === 0) {
      lines.push("No repeated behavioral rules identified yet.");
      return lines.join("\n");
    }

    const byCategory = {
      workflow: rules.filter((r) => r.category === "workflow"),
      correction: rules.filter((r) => r.category === "correction"),
      tool_usage: rules.filter((r) => r.category === "tool_usage"),
    };

    if (byCategory.correction.length > 0) {
      lines.push("", "### Critical Corrections (Highest Precedence)");
      for (const r of byCategory.correction) {
        lines.push(`- **${r.rule}** (observed ${r.observedCount}x in sessions: ${r.evidence.slice(0, 3).join(", ")})`);
      }
    }

    if (byCategory.workflow.length > 0) {
      lines.push("", "### Standard Workflow Rules");
      for (const r of byCategory.workflow) {
        lines.push(`- **${r.rule}** (observed ${r.observedCount}x)`);
      }
    }

    if (byCategory.tool_usage.length > 0) {
      lines.push("", "### Tool & Environment Preferences");
      for (const r of byCategory.tool_usage) {
        lines.push(`- **${r.rule}** (observed ${r.observedCount}x)`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }
}
