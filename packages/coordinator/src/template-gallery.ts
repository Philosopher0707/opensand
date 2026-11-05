import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentStore, AgentRecord } from "./agent-store.js";
import { AgentTemplate } from "./types.js";

export type TemplateCategory = "engineering" | "security" | "product" | "research";

export interface GalleryTemplateItem {
  id: string;
  name: string;
  role: string;
  description: string;
  category: TemplateCategory;
  author: string;
  version: string;
  icon: string;
  tags: string[];
  stars: number;
  downloads: number;
  recommendedModel: string;
  systemPrompt: string;
  allowedTools: string[];
  starterTasks?: string[];
  metadata?: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  isCommunity?: boolean;
  installed?: boolean;
}

export interface GalleryQueryOptions {
  category?: TemplateCategory | "all";
  query?: string;
  tag?: string;
}

export const CURATED_GALLERY_TEMPLATES: GalleryTemplateItem[] = [
  {
    id: "code-reviewer",
    name: "Code Reviewer & PR Auditor",
    role: "Lead Code Reviewer & Quality Gatekeeper",
    description: "Thorough review of Git diffs, enforcing architectural invariants, finding corner cases, and validating test suites.",
    category: "engineering",
    author: "OpenSand Core",
    version: "1.2.0",
    icon: "🔍",
    tags: ["code-review", "git", "standards", "lint", "ci"],
    stars: 428,
    downloads: 1420,
    recommendedModel: "deepseek/deepseek-v4.1-flash-1017",
    systemPrompt: `You are the Lead Code Reviewer & Quality Gatekeeper.
Your responsibilities:
1. Inspect git diffs surgically without making speculative edits.
2. Verify that test assertions are honest and that no test is silenced or weakened.
3. Catch architectural drift, memory leaks, missing error checks, and type unsafety.
4. Provide structured, actionable code feedback with file paths and line ranges.`,
    allowedTools: ["git_diff", "git_status", "read_file", "list_directory", "exec_command"],
    starterTasks: [
      "Review working tree git diff for code quality and test coverage",
      "Check recent commit history for breaking changes or anti-patterns",
    ],
    createdAtMs: 1730000000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "security-auditor",
    name: "Security Vulnerability Auditor",
    role: "Senior Application Security Engineer",
    description: "Audits codebases for secret leaks, injection vulnerabilities, privilege escalation, and insecure dependencies.",
    category: "security",
    author: "OpenSand Core",
    version: "1.1.0",
    icon: "🛡️",
    tags: ["security", "audit", "secrets", "cve", "sast"],
    stars: 512,
    downloads: 1890,
    recommendedModel: "claude-3-5-sonnet-20241022",
    systemPrompt: `You are the Senior Application Security Engineer.
Your responsibilities:
1. Scan for hardcoded credentials, API keys, and sensitive environment variables.
2. Evaluate input sanitization against SQL injection, XSS, and command injection attacks.
3. Verify that all security gates and authorization boundaries fail closed.
4. Report vulnerabilities with severity, exploitability, and concrete remediation steps.`,
    allowedTools: ["read_file", "list_directory", "exec_command", "vault_list_secrets"],
    starterTasks: [
      "Scan repository for accidentally committed secrets or tokens",
      "Audit API endpoints and input parsers for injection vulnerabilities",
    ],
    createdAtMs: 1730000000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "refactoring-architect",
    name: "Refactoring Architect",
    role: "Software Architecture & Technical Debt Specialist",
    description: "Simplifies bloated modules, eliminates cyclic dependencies, reduces defensive boilerplate, and deepens shallow abstractions.",
    category: "engineering",
    author: "Community",
    version: "2.0.1",
    icon: "🏗️",
    tags: ["refactoring", "clean-code", "dry", "architecture", "tdd"],
    stars: 384,
    downloads: 980,
    recommendedModel: "claude-3-7-sonnet",
    systemPrompt: `You are the Refactoring Architect.
Your responsibilities:
1. Deepen shallow interfaces: replace 200-line fragmented procedures with cohesive 40-line modules.
2. Preserve existing behaviour rigorously: run and maintain tests before and after every transform.
3. Remove dead code, redundant abstractions, and speculative hooks.
4. Maintain high workspace hygiene with minimal blast radius.`,
    allowedTools: ["read_file", "edit_file", "write_file", "list_directory", "exec_command", "git_status"],
    starterTasks: [
      "Find functions over 80 lines and extract clean single-purpose helpers",
      "Refactor repetitive error handling into unified safe pipelines",
    ],
    createdAtMs: 1730100000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "linear-master",
    name: "Linear Issue & Sprint Commander",
    role: "Agile Delivery & Project Lead",
    description: "Synchronizes agent tasks with Linear issues, breaks down PRDs into vertical slices, and tracks milestone progress.",
    category: "product",
    author: "OpenSand Core",
    version: "1.0.0",
    icon: "📐",
    tags: ["linear", "agile", "issues", "sprint", "roadmap"],
    stars: 295,
    downloads: 740,
    recommendedModel: "gemini-2.0-flash",
    systemPrompt: `You are the Agile Delivery & Project Lead.
Your responsibilities:
1. Decompose high-level feature requests into discrete, agent-ready Linear issues.
2. Assign priority levels, team keys, and acceptance criteria.
3. Synchronize local workspace tasks with external Linear project boards.
4. Maintain clean issue statuses and file progress reports.`,
    allowedTools: ["linear_create_issue", "show_app_access", "create_agent_task", "list_agent_tasks", "update_agent_task"],
    starterTasks: [
      "Break down a feature specification into actionable Linear issues",
      "Sync local pending tasks with team sprint backlog",
    ],
    createdAtMs: 1730200000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "devops-sentinel",
    name: "DevOps & Docker Sentinel",
    role: "Infrastructure & Container Operations Engineer",
    description: "Configures hermetic Docker environments, diagnoses build/test failures, and optimizes CI/CD pipeline definitions.",
    category: "security",
    author: "Community",
    version: "1.3.0",
    icon: "🐳",
    tags: ["docker", "devops", "ci-cd", "bash", "deploy"],
    stars: 340,
    downloads: 870,
    recommendedModel: "deepseek/deepseek-v4.1-flash-1017",
    systemPrompt: `You are the Infrastructure & Container Operations Engineer.
Your responsibilities:
1. Write non-interactive, reproducible bash scripts and Dockerfiles.
2. Debug container build failures, port conflicts, and environment variables.
3. Optimize CI/CD workflow steps for fast parallel execution and caching.
4. Enforce principle of least privilege in container configurations.`,
    allowedTools: ["exec_command", "read_file", "write_file", "edit_file", "list_directory"],
    starterTasks: [
      "Create an optimized multi-stage Dockerfile for the project",
      "Diagnose failing CI test step and reproduce locally in Docker",
    ],
    createdAtMs: 1730300000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "slack-scout",
    name: "Slack Collaboration Scout",
    role: "Team Notifier & Collaboration Agent",
    description: "Sends deployment alerts, summarizes session conclusions to team channels, and coordinates cross-functional handoffs.",
    category: "product",
    author: "OpenSand Core",
    version: "1.0.0",
    icon: "💬",
    tags: ["slack", "notifications", "alerts", "team", "handoff"],
    stars: 260,
    downloads: 620,
    recommendedModel: "gemini-2.0-flash",
    systemPrompt: `You are the Team Notifier & Collaboration Agent.
Your responsibilities:
1. Draft concise executive summaries of agent sessions for Slack channels.
2. Emit actionable incident alerts with links, timestamps, and error traces.
3. Post changelogs and deployment confirmations to #general or team channels.
4. Check Slack integration health via show_app_access before posting.`,
    allowedTools: ["slack_post_message", "show_app_access", "recall_memories"],
    starterTasks: [
      "Send a release summary notification to the #releases channel",
      "Post test failure diagnostics to the #alerts channel",
    ],
    createdAtMs: 1730400000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "deep-researcher",
    name: "Deep Codebase Researcher",
    role: "Reverse Engineering & Code Archaeology Specialist",
    description: "Builds architectural maps of unfamiliar codebases, traces call paths, finds references, and uncovers legacy invariants.",
    category: "research",
    author: "Community",
    version: "1.4.0",
    icon: "🔬",
    tags: ["research", "exploration", "architecture", "call-graph"],
    stars: 485,
    downloads: 1310,
    recommendedModel: "claude-3-7-sonnet",
    systemPrompt: `You are the Reverse Engineering & Code Archaeology Specialist.
Your responsibilities:
1. Ground before action: read actual source files and manifests before forming hypotheses.
2. Trace call paths, exports, entry points, and state lifecycles systematically.
3. Uncover unwritten domain invariants and record them in architectural documentation.
4. Guide the team through complex unfamiliar subsystems with precision.`,
    allowedTools: ["read_file", "list_directory", "exec_command", "discover_tools"],
    starterTasks: [
      "Map all API routes and entry points in the repository",
      "Trace how user sessions are authenticated and persisted across turns",
    ],
    createdAtMs: 1730500000000,
    updatedAtMs: 1730700000000,
  },
  {
    id: "github-automator",
    name: "GitHub PR & Issue Automator",
    role: "Open Source & GitHub Workflow Maintainer",
    description: "Inspects open pull requests, checks PR comments, files issues, and drafts descriptive release changelogs.",
    category: "engineering",
    author: "OpenSand Core",
    version: "1.1.0",
    icon: "🐙",
    tags: ["github", "pull-request", "issues", "changelog", "git"],
    stars: 390,
    downloads: 1040,
    recommendedModel: "deepseek/deepseek-v4.1-flash-1017",
    systemPrompt: `You are the Open Source & GitHub Workflow Maintainer.
Your responsibilities:
1. Inspect pull requests, commit ranges, and review comments on GitHub.
2. Automate creation of descriptive issue tickets with reproduction steps.
3. Draft release notes and changelog markdown summaries from merged commits.
4. Interact securely through GitHub App credentials.`,
    allowedTools: ["github_app_action", "show_app_access", "git_status", "git_diff", "git_commit"],
    starterTasks: [
      "Inspect recent pull requests and summarize changed behaviors",
      "File an issue report for an observed test regression",
    ],
    createdAtMs: 1730600000000,
    updatedAtMs: 1730700000000,
  },
];

export interface TemplateGalleryOptions {
  storagePath?: string;
  agentStore?: AgentStore;
}

export class TemplateGallery {
  private storagePath: string;
  private agentStore?: AgentStore;
  private templates: Map<string, GalleryTemplateItem> = new Map();

  constructor(options?: TemplateGalleryOptions) {
    this.storagePath =
      options?.storagePath ||
      path.join(os.homedir(), ".opensand", "gallery_templates.json");
    this.agentStore = options?.agentStore;
    this.initializeCuratedTemplates();
    this.loadFromDisk();
  }

  private initializeCuratedTemplates(): void {
    for (const tpl of CURATED_GALLERY_TEMPLATES) {
      this.templates.set(tpl.id, { ...tpl, isCommunity: false });
    }
  }

  private loadFromDisk(): void {
    try {
      if (fsSync.existsSync(this.storagePath)) {
        const raw = fsSync.readFileSync(this.storagePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.id) {
              this.templates.set(item.id, { ...item, isCommunity: true });
            }
          }
        }
      }
    } catch {
      // Non-fatal if missing or unreadable
    }
  }

  private async saveToDisk(): Promise<void> {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fsSync.existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      }
      const communityItems = Array.from(this.templates.values()).filter(
        (t) => t.isCommunity
      );
      const tmpPath = `${this.storagePath}.${Date.now()}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(communityItems, null, 2), {
        mode: 0o600,
      });
      await fs.rename(tmpPath, this.storagePath);
    } catch {
      // Best-effort disk persistence
    }
  }

  public async listTemplates(
    options?: GalleryQueryOptions,
    installedNames?: Set<string>
  ): Promise<GalleryTemplateItem[]> {
    let installedSet = installedNames;
    if (!installedSet && this.agentStore) {
      try {
        const localAgents = await this.agentStore.listAgents();
        installedSet = new Set(localAgents.map((a) => a.name.toLowerCase().trim()));
      } catch {
        installedSet = new Set();
      }
    }

    let items = Array.from(this.templates.values());

    // Category filter
    if (options?.category && options.category !== "all") {
      items = items.filter((t) => t.category === options.category);
    }

    // Tag filter
    if (options?.tag) {
      const targetTag = options.tag.toLowerCase();
      items = items.filter((t) =>
        t.tags.some((tag) => tag.toLowerCase() === targetTag)
      );
    }

    // Search query filter
    if (options?.query && options.query.trim()) {
      const q = options.query.toLowerCase().trim();
      items = items.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.role.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    }

    // Mark installed status
    return items.map((item) => ({
      ...item,
      installed: installedSet ? installedSet.has(item.name.toLowerCase().trim()) : false,
    }));
  }

  public getTemplate(id: string): GalleryTemplateItem | undefined {
    return this.templates.get(id);
  }

  public async publishTemplate(
    input: Omit<GalleryTemplateItem, "createdAtMs" | "updatedAtMs" | "isCommunity" | "downloads" | "stars">
  ): Promise<GalleryTemplateItem> {
    const now = Date.now();
    const item: GalleryTemplateItem = {
      ...input,
      stars: 1,
      downloads: 0,
      isCommunity: true,
      createdAtMs: now,
      updatedAtMs: now,
    };

    this.templates.set(item.id, item);
    await this.saveToDisk();
    return item;
  }

  public async deleteTemplate(id: string): Promise<boolean> {
    const existing = this.templates.get(id);
    if (!existing || !existing.isCommunity) {
      return false; // Cannot delete curated templates
    }
    this.templates.delete(id);
    await this.saveToDisk();
    return true;
  }

  public async installTemplate(
    id: string,
    targetStore?: AgentStore
  ): Promise<{ agent: AgentRecord; template: GalleryTemplateItem }> {
    const store = targetStore || this.agentStore;
    if (!store) {
      throw new Error("No AgentStore provided to install template into.");
    }

    const tpl = this.templates.get(id);
    if (!tpl) {
      throw new Error(`Template not found in gallery: ${id}`);
    }

    // Convert gallery item to AgentTemplate contract
    const agentTemplate: AgentTemplate = {
      templateVersion: tpl.version,
      name: tpl.name,
      role: tpl.role,
      description: tpl.description,
      systemPrompt: tpl.systemPrompt,
      kind: "AGENT",
      model: tpl.recommendedModel,
      allowedTools: tpl.allowedTools,
      metadata: {
        galleryTemplateId: tpl.id,
        category: tpl.category,
        author: tpl.author,
        icon: tpl.icon,
        tags: tpl.tags,
        starterTasks: tpl.starterTasks,
      },
      exportedAtMs: Date.now(),
    };

    const agent = await store.importTemplate(agentTemplate);

    // Bump download count
    tpl.downloads = (tpl.downloads || 0) + 1;
    if (tpl.isCommunity) {
      await this.saveToDisk();
    }

    return { agent, template: tpl };
  }
}

export const defaultTemplateGallery = new TemplateGallery();
