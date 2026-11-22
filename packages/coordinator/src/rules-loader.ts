import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { wrapUntrusted } from "@opensand/shared";

export interface RulesLoaderOptions {
  workspaceDir: string;
  globalRulesPath?: string;
  budgetTokens?: number;
  perFileTokens?: number;
}

export interface RuleFileInfo {
  path: string;
  tokens: number;
  truncated: boolean;
}

export interface RulesLoadResult {
  globalRules: string;
  rulesContext: string;
  files: RuleFileInfo[];
}

interface CachedFile {
  path: string;
  exists: boolean;
  mtimeMs: number;
  size: number;
  rawContent: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export class RulesLoader {
  public readonly workspaceDir: string;
  public readonly globalRulesPath: string;
  public readonly budgetTokens: number;
  public readonly perFileTokens: number;

  public globalRules: string = "";
  public rulesContext: string = "";
  public files: RuleFileInfo[] = [];

  private knownPaths: Set<string> = new Set();
  private fileCache: Map<string, CachedFile> = new Map();

  constructor(options: RulesLoaderOptions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.globalRulesPath = options.globalRulesPath
      ? path.resolve(options.globalRulesPath)
      : path.join(os.homedir(), ".opensand", "rules", "global.md");
    this.budgetTokens = options.budgetTokens ?? 4000;
    this.perFileTokens = options.perFileTokens ?? 2000;

    this.load();
  }

  public static discoverAndFormat(
    workspaceDir: string,
    options?: Omit<RulesLoaderOptions, "workspaceDir">
  ): RulesLoadResult {
    const loader = new RulesLoader({ workspaceDir, ...options });
    return {
      globalRules: loader.globalRules,
      rulesContext: loader.rulesContext,
      files: loader.files,
    };
  }

  private findNestedRuleFiles(currentDir: string, depth: number): string[] {
    if (depth > 3) return [];
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist"
        ) {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 3) {
            results.push(...this.findNestedRuleFiles(fullPath, depth + 1));
          }
        } else if (entry.isFile() && depth >= 1 && entry.name === "AGENTS.md") {
          results.push(fullPath);
        }
      }
    } catch {
      // Missing or unreadable directories skipped silently
    }
    return results;
  }

  private statAndRead(filePath: string): CachedFile {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const rawContent = fs.readFileSync(filePath, "utf-8");
        return {
          path: filePath,
          exists: true,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          rawContent,
        };
      }
    } catch {
      // Inaccessible or non-existent file
    }
    return {
      path: filePath,
      exists: false,
      mtimeMs: 0,
      size: 0,
      rawContent: "",
    };
  }

  private discoverPaths(): {
    globalPath: string;
    rootPath?: string;
    nestedPaths: string[];
  } {
    const globalPath = this.globalRulesPath;

    let rootPath: string | undefined;
    const rootAgents = path.join(this.workspaceDir, "AGENTS.md");
    const rootClaude = path.join(this.workspaceDir, "CLAUDE.md");
    if (fs.existsSync(rootAgents)) {
      rootPath = rootAgents;
    } else if (fs.existsSync(rootClaude)) {
      rootPath = rootClaude;
    }

    const nestedPaths = this.findNestedRuleFiles(this.workspaceDir, 0);
    nestedPaths.sort((a, b) => a.localeCompare(b));

    return { globalPath, rootPath, nestedPaths };
  }

  private applyBudgetAndFormat(
    globalPath: string,
    rootPath: string | undefined,
    nestedPaths: string[]
  ): {
    globalRules: string;
    rulesContext: string;
    files: RuleFileInfo[];
  } {
    const files: RuleFileInfo[] = [];
    let remainingBudget = this.budgetTokens;

    // 1. Process Global Rules
    let globalRules = "";
    const globalCached = this.fileCache.get(globalPath);
    if (globalCached && globalCached.exists && globalCached.rawContent.length > 0) {
      const raw = globalCached.rawContent;
      const rawTokens = estimateTokens(raw);
      // Global always keeps at least 500 tokens (or its own tokens if smaller)
      const globalCap = Math.max(500, Math.min(this.perFileTokens, this.budgetTokens));
      if (rawTokens <= globalCap) {
        globalRules = raw;
        const tokens = rawTokens;
        files.push({ path: globalPath, tokens, truncated: false });
        remainingBudget = Math.max(0, remainingBudget - tokens);
      } else {
        const fileName = path.basename(globalPath);
        const notice = `\n[... Rule file '${fileName}' truncated to maintain token budget ...]\n`;
        const noticeTokens = estimateTokens(notice);
        const maxContentChars = Math.max(0, (globalCap - noticeTokens) * 4);
        globalRules = raw.slice(0, maxContentChars) + notice;
        const tokens = estimateTokens(globalRules);
        files.push({ path: globalPath, tokens, truncated: true });
        remainingBudget = Math.max(0, remainingBudget - tokens);
      }
    }

    // 2. Process Repo Root and Nested Files
    const wrappedSections: string[] = [];
    const repoFiles: Array<{ filePath: string; origin: string }> = [];

    if (rootPath) {
      const fileName = path.basename(rootPath);
      repoFiles.push({ filePath: rootPath, origin: `repo:${fileName}` });
    }

    for (const nestedPath of nestedPaths) {
      const rel = path.relative(this.workspaceDir, nestedPath);
      repoFiles.push({ filePath: nestedPath, origin: `repo:${rel}` });
    }

    for (const { filePath, origin } of repoFiles) {
      const cached = this.fileCache.get(filePath);
      if (!cached || !cached.exists || cached.rawContent.length === 0) {
        continue;
      }

      const raw = cached.rawContent;
      const rawTokens = estimateTokens(raw);
      const fileCap = Math.min(this.perFileTokens, remainingBudget);

      if (remainingBudget <= 0 || fileCap <= 0) {
        files.push({ path: filePath, tokens: 0, truncated: true });
        continue;
      }

      const fileName = path.basename(filePath);
      const notice = `\n[... Rule file '${fileName}' truncated to maintain token budget ...]\n`;
      const noticeTokens = estimateTokens(notice);

      if (rawTokens <= fileCap) {
        const content = raw;
        const tokens = rawTokens;
        remainingBudget = Math.max(0, remainingBudget - tokens);
        files.push({ path: filePath, tokens, truncated: false });
        wrappedSections.push(wrapUntrusted(content, { source: "file", origin }));
      } else if (fileCap > noticeTokens) {
        const maxContentChars = Math.max(0, (fileCap - noticeTokens) * 4);
        const content = raw.slice(0, maxContentChars) + notice;
        const tokens = estimateTokens(content);
        remainingBudget = Math.max(0, remainingBudget - tokens);
        files.push({ path: filePath, tokens, truncated: true });
        wrappedSections.push(wrapUntrusted(content, { source: "file", origin }));
      } else {
        files.push({ path: filePath, tokens: 0, truncated: true });
      }
    }

    const rulesContext = wrappedSections.join("\n\n");
    return { globalRules, rulesContext, files };
  }

  public load(): RulesLoadResult {
    const { globalPath, rootPath, nestedPaths } = this.discoverPaths();

    this.knownPaths.clear();
    this.knownPaths.add(globalPath);
    this.knownPaths.add(path.join(this.workspaceDir, "AGENTS.md"));
    this.knownPaths.add(path.join(this.workspaceDir, "CLAUDE.md"));
    for (const np of nestedPaths) {
      this.knownPaths.add(np);
    }

    for (const p of this.knownPaths) {
      this.fileCache.set(p, this.statAndRead(p));
    }

    const formatted = this.applyBudgetAndFormat(globalPath, rootPath, nestedPaths);
    this.globalRules = formatted.globalRules;
    this.rulesContext = formatted.rulesContext;
    this.files = formatted.files;

    return formatted;
  }

  public refresh(): boolean {
    const { globalPath, rootPath, nestedPaths } = this.discoverPaths();

    // Check if discovered paths changed
    const currentPaths = new Set<string>();
    currentPaths.add(globalPath);
    currentPaths.add(path.join(this.workspaceDir, "AGENTS.md"));
    currentPaths.add(path.join(this.workspaceDir, "CLAUDE.md"));
    for (const np of nestedPaths) {
      currentPaths.add(np);
    }

    let changed = false;

    // Check for added or removed paths
    for (const p of currentPaths) {
      if (!this.knownPaths.has(p)) {
        changed = true;
        this.knownPaths.add(p);
      }
    }

    // Re-stat known paths
    for (const p of this.knownPaths) {
      const cached = this.fileCache.get(p);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(p);
      } catch {
        // File does not exist
      }

      if (stat && stat.isFile()) {
        if (!cached || !cached.exists || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
          changed = true;
          const rawContent = fs.readFileSync(p, "utf-8");
          this.fileCache.set(p, {
            path: p,
            exists: true,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            rawContent,
          });
        }
      } else {
        if (cached && cached.exists) {
          changed = true;
          this.fileCache.set(p, {
            path: p,
            exists: false,
            mtimeMs: 0,
            size: 0,
            rawContent: "",
          });
        }
      }
    }

    if (changed) {
      const formatted = this.applyBudgetAndFormat(globalPath, rootPath, nestedPaths);
      this.globalRules = formatted.globalRules;
      this.rulesContext = formatted.rulesContext;
      this.files = formatted.files;
    }

    return changed;
  }
}
