import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryStore } from "./memory-store.js";

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

        // 2. Explicit corrections — record the user's own words as the rule,
        // not a canned slogan, so the memory reflects what was actually said.
        if (q.isCorrection) {
          this.recordPattern(patternMap, this.ruleFromCorrection(q.text), q.sessionId, "correction");
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

  /**
   * Run the full SIM (self-improvement) cycle: extract habits/corrections from
   * recent transcripts, persist them as user log-tier memory facts (deduped),
   * then retroactively mark any fact contradicted by a user correction as
   * observedOutcome="negative" so it is excluded from future prompt context.
   *
   * Returns a summary object suitable for surfacing to the caller/UI.
   */
  async runSIMCycle(options?: {
    maxChats?: number;
    memoryStore?: MemoryStore;
  }): Promise<{
    transcriptsAnalyzed: number;
    queriesExtracted: number;
    correctionsFound: number;
    rulesLearned: number;
    factsPersisted: number;
    factsMarkedNegative: number;
    persisted: Array<{ rule: string; factId?: string; error?: string }>;
    negatedFacts: Array<{ factId: string; text: string; matchedBy: string }>;
  }> {
    const maxChats = options?.maxChats ?? 50;
    const memoryStore = options?.memoryStore ?? new MemoryStore();

    // Step 1: Extract habits/corrections from transcripts and write learned_rules.md
    const report = await this.analyzeTranscripts(maxChats);

    // Step 2: Persist each extracted rule as a MemoryFact (deduped against existing)
    const existingFacts = await memoryStore.listMemories({ scope: "user", tier: "log" });
    const existingTexts = new Set(existingFacts.map((f) => f.text.toLowerCase().trim()));

    const persisted: Array<{ rule: string; factId?: string; error?: string }> = [];
    for (const rule of report.rules) {
      const key = rule.rule.toLowerCase().trim();
      if (existingTexts.has(key)) {
        persisted.push({ rule: rule.rule, factId: undefined, error: "skipped: duplicate" });
        continue;
      }
      try {
        const fact = await memoryStore.addMemoryWithOutcome({
          text: rule.rule,
          scope: "user",
          tier: "log",
          agentId: undefined,
          predictedOutcome: "positive",
          observedOutcome: undefined,
        });
        persisted.push({ rule: rule.rule, factId: fact.factId });
        existingTexts.add(key);
      } catch (err: any) {
        persisted.push({ rule: rule.rule, error: err.message });
      }
    }

    // Step 3: SIM correction loop — mark facts negative when user corrections contradict them
    const corrections = await this.getCorrectionQueries(maxChats);
    const negationWords = [
      "don't",
      "do not",
      "stop",
      "no,",
      "no ",
      "undo",
      "incorrect",
      "that's wrong",
      "not",
    ];

    const splitClauses = (text: string): string[] =>
      text.split(/[.!?;]\s*/).filter(Boolean);

    const factHasNegatedTerm = (factWords: string[], cText: string): boolean => {
      const clauses = splitClauses(cText);
      return clauses.some((clause) => {
        const hasNegation = negationWords.some((n) => clause.includes(n));
        if (!hasNegation) return false;
        return factWords.some((fw) => clause.includes(fw));
      });
    };

    const negatedFacts: Array<{ factId: string; text: string; matchedBy: string }> = [];
    const candidateFacts = await memoryStore.listMemories({
      scope: "user",
      tier: "log",
      observedOutcome: undefined,
    });

    for (const fact of candidateFacts) {
      if (fact.predictedOutcome !== "positive") continue;
      const factText = fact.text.toLowerCase();

      const factWords = factText
        .split(/\s+/)
        .filter(
          (w) =>
            w.length > 3 &&
            ![
              "always","never","should","would","could","prefer","use","uses","with","from","that","this",
              "have","been","were","them","they","their","what","when","where","while","after","before",
              "because","since","until","unless","although","though","whether","however","therefore",
              "moreover","furthermore","otherwise","meanwhile","indeed","certainly","actually",
              "basically","simply","really","quite","very","just","only","even","still","also","already",
              "yet","soon","now","then","here","there","every","each","all","any","some","many","much",
              "few","little","less","more","most","least","own","same","such","no","nor","not","so","than",
              "too","s","t","can","will","don","now",
            ].includes(w)
        )
        .slice(0, 8);

      for (const correction of corrections) {
        const cText = correction.text.toLowerCase();
        if (!factHasNegatedTerm(factWords, cText)) continue;

        try {
          await memoryStore.updateMemoryOutcome(fact.factId, "negative", "user");
          negatedFacts.push({ factId: fact.factId, text: fact.text, matchedBy: correction.text });
        } catch {
          // Fact may have already been updated; skip
        }
        break;
      }
    }

    return {
      transcriptsAnalyzed: report.totalTranscriptsAnalyzed,
      queriesExtracted: report.extractedQueriesCount,
      correctionsFound: report.correctionsCount,
      rulesLearned: report.rules.length,
      factsPersisted: persisted.length,
      factsMarkedNegative: negatedFacts.length,
      persisted,
      negatedFacts,
    };
  }

  /**
   * Return raw user queries detected as corrections across recent transcripts.
   * Used by the SIM loop to retroactively mark contradicted memory facts as
   * observedOutcome="negative" (don't repeat failed attempts).
   */
  async getCorrectionQueries(maxChatsToRead = 50): Promise<Array<{ text: string; sessionId: string }>> {
    const corrections: Array<{ text: string; sessionId: string }> = [];

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

      candidates.sort((a, b) => b.mtime - a.mtime);
      const targetDirs = candidates.slice(0, maxChatsToRead);

      for (const { dir } of targetDirs) {
        const transcriptPath = path.join(this.sessionsDir, dir, "transcript.txt");
        const content = await fs.readFile(transcriptPath, "utf-8");

        const queryRegex = /<user_query>([\s\S]*?)<\/user_query>/g;
        let match;
        while ((match = queryRegex.exec(content)) !== null) {
          const queryText = match[1].trim();
          if (!queryText) continue;
          if (this.isUserCorrection(queryText)) {
            corrections.push({ text: queryText, sessionId: dir });
          }
        }
      }
    } catch {
      // No transcripts available yet
    }

    return corrections;
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

  /**
   * Build a remembered rule from the user's own correction wording, trimmed to a
   * single imperative sentence when possible. Falls back to the full query text
   * if no clean sentence boundary exists.
   */
  private ruleFromCorrection(query: string): string {
    const trimmed = query.trim();
    const delimiters = [
      trimmed.indexOf(". ", 0),
      trimmed.indexOf("! ", 0),
      trimmed.indexOf("? ", 0),
    ].filter((i) => i !== -1);
    const end = delimiters.length > 0 ? Math.min(...delimiters) : -1;
    const sentence = end === -1 ? trimmed : trimmed.slice(0, end).trim();
    return sentence.length >= 6 ? sentence : trimmed;
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
