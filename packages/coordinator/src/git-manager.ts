import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

export interface GitRepoStatus {
  branch: string;
  isClean: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
}

export interface GitDiffSummary {
  diff: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface CreatePrInput {
  title: string;
  body: string;
  baseBranch?: string;
  headBranch?: string;
  draft?: boolean;
}

export interface PrReviewIssue {
  file: string;
  line?: number;
  severity: "critical" | "warning" | "suggestion";
  comment: string;
}

export interface PrReviewResult {
  prReference: string;
  verdict: "APPROVED" | "CHANGES_REQUESTED" | "COMMENT";
  summary: string;
  issues: PrReviewIssue[];
  rawDiffSnippet?: string;
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string;
  isBare?: boolean;
}

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /^id_rsa(?:\..+)?$/i,
  /^id_ed25519(?:\..+)?$/i,
  /(?:^|\/)\.vault\./i,
  /(?:^|\/)\.aws\/credentials/i,
  /(?:^|\/)\.ssh\//i,
];

export function isSensitiveGitFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);
  return SENSITIVE_FILE_PATTERNS.some((pat) => pat.test(basename) || pat.test(normalized));
}

/**
 * Normalize an arbitrary agent name into a Git-safe branch segment.
 */
export function sanitizeBranchName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export class GitManager {
  private defaultCwd: string;

  constructor(defaultCwd?: string) {
    this.defaultCwd = defaultCwd ?? process.cwd();
  }

  private gitSafeEnv(): NodeJS.ProcessEnv {
    // Strip ambient GIT_* variables so a nested git invocation cannot
    // re-target the enclosing repository (e.g. when tests run under the
    // pre-commit hook, git sets GIT_DIR/GIT_INDEX_FILE; leaking them
    // lets a temp-repo commit be written to the outer repo).
    const env: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
    };
    for (const k of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_PREFIX",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete env[k];
    }
    return env as NodeJS.ProcessEnv;
  }

  private async execGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", ["--no-pager", ...args], {
      cwd: cwd ?? this.defaultCwd,
      env: { ...this.gitSafeEnv(), CI: "true" },
    });
  }

  private async execGh(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("gh", args, {
      cwd: cwd ?? this.defaultCwd,
      env: { ...this.gitSafeEnv(), CI: "true", NO_COLOR: "1" },
    });
  }

  /**
   * Get parsed status of git repository
   */
  async getStatus(repoDir?: string): Promise<GitRepoStatus> {
    const cwd = repoDir ?? this.defaultCwd;

    // Current branch
    let branch = "HEAD";
    try {
      const { stdout } = await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      branch = stdout.trim();
    } catch {
      // Detached head or not a git repo
    }

    const { stdout } = await this.execGit(["status", "--porcelain=v1"], cwd);
    const lines = stdout.split("\n").filter((l) => l.trim().length > 0);

    const modified: string[] = [];
    const staged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3).trim();

      if (indexStatus === "?" && workTreeStatus === "?") {
        untracked.push(filePath);
      } else {
        if (indexStatus !== " " && indexStatus !== "?") {
          staged.push(filePath);
        }
        if (workTreeStatus !== " " && workTreeStatus !== "?") {
          modified.push(filePath);
        }
      }
    }

    return {
      branch,
      isClean: lines.length === 0,
      modified,
      staged,
      untracked,
    };
  }

  /**
   * Get git diff and summary statistics
   */
  async getDiff(staged = false, repoDir?: string, range?: string): Promise<GitDiffSummary> {
    const cwd = repoDir ?? this.defaultCwd;
    const args = range ? ["diff", range] : staged ? ["diff", "--cached"] : ["diff"];

    const { stdout: diff } = await this.execGit(args, cwd);

    // Get stat
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    try {
      const statArgs = range
        ? ["diff", range, "--shortstat"]
        : staged
          ? ["diff", "--cached", "--shortstat"]
          : ["diff", "--shortstat"];
      const { stdout: statOut } = await this.execGit(statArgs, cwd);
      const statMatch = /(\d+)\s+file[s]?\s+changed(?:,\s+(\d+)\s+insertion[s]?\(\+\))?(?:,\s+(\d+)\s+deletion[s]?\(-\))?/i.exec(statOut);

      if (statMatch) {
        filesChanged = parseInt(statMatch[1] || "0", 10);
        insertions = parseInt(statMatch[2] || "0", 10);
        deletions = parseInt(statMatch[3] || "0", 10);
      }
    } catch {
      // Ignore
    }

    return {
      diff,
      filesChanged,
      insertions,
      deletions,
    };
  }

  /**
   * Check if the specified directory is inside a Git working tree.
   */
  async isGitRepository(repoDir?: string): Promise<boolean> {
    try {
      const { stdout } = await this.execGit(["rev-parse", "--is-inside-work-tree"], repoDir);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Create an isolated git worktree for a branch
   */
  async createWorktree(branchName: string, customPath?: string, repoDir?: string): Promise<{ worktreePath: string; branch: string }> {
    const cwd = repoDir ?? this.defaultCwd;
    const sanitizedBranch = branchName.replace(/[^a-zA-Z0-9/_-]+/g, "-");
    const worktreeDir = customPath ?? path.join(os.tmpdir(), `opensand-worktree-${sanitizedBranch.replace(/\//g, "-")}-${Date.now()}`);

    let branchExists = false;
    try {
      await this.execGit(["rev-parse", "--verify", sanitizedBranch], cwd);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      await this.execGit(["worktree", "add", worktreeDir, sanitizedBranch], cwd);
    } else {
      await this.execGit(["worktree", "add", "-b", sanitizedBranch, worktreeDir, "HEAD"], cwd);
    }

    return {
      worktreePath: worktreeDir,
      branch: sanitizedBranch,
    };
  }

  /**
   * Stage all changes and generate a commit
   */
  async autoCommit(message?: string, repoDir?: string): Promise<{ commitHash: string; branch: string; message: string }> {
    const cwd = repoDir ?? this.defaultCwd;

    // Stage changes
    await this.execGit(["add", "-A"], cwd);

    // Filter out and unstage any sensitive secret files matching .env*, *.pem, *.key, etc.
    const preStatus = await this.getStatus(cwd);
    const sensitiveStaged = preStatus.staged.filter(isSensitiveGitFile);
    if (sensitiveStaged.length > 0) {
      await this.execGit(["reset", "HEAD", "--", ...sensitiveStaged], cwd);
    }

    const status = await this.getStatus(cwd);
    if (status.staged.length === 0) {
      throw new Error("No safe changes staged to commit (sensitive files were excluded)");
    }

    let commitMsg = message?.trim();
    if (!commitMsg) {
      // Infer simple conventional commit from staged files
      const firstFile = status.staged[0];
      const isTest = status.staged.every((f) => f.includes("test"));
      const isDoc = status.staged.every((f) => f.endsWith(".md") || f.endsWith(".txt"));
      const prefix = isTest ? "test" : isDoc ? "docs" : "feat";
      commitMsg = `${prefix}: update ${path.basename(firstFile)}${status.staged.length > 1 ? ` and ${status.staged.length - 1} other files` : ""}`;
    }

    await this.execGit(["commit", "-m", commitMsg], cwd);

    const { stdout: hashOut } = await this.execGit(["rev-parse", "--short", "HEAD"], cwd);
    const { stdout: branchOut } = await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);

    return {
      commitHash: hashOut.trim(),
      branch: branchOut.trim(),
      message: commitMsg,
    };
  }

  /**
   * Create a pull request using GitHub CLI (`gh pr create`)
   */
  async createPullRequest(input: CreatePrInput, repoDir?: string): Promise<{ prUrl: string; title: string }> {
    const cwd = repoDir ?? this.defaultCwd;

    const args = ["pr", "create", "--title", input.title, "--body", input.body];
    if (input.baseBranch) args.push("--base", input.baseBranch);
    if (input.headBranch) args.push("--head", input.headBranch);
    if (input.draft) args.push("--draft");

    const { stdout } = await this.execGh(args, cwd);
    const prUrl = stdout.trim();

    return {
      prUrl,
      title: input.title,
    };
  }

  /**
   * Autonomous PR review agent: inspects diff and reports issues & verdict
   */
  async reviewPullRequest(prReference: string, repoDir?: string): Promise<PrReviewResult> {
    const cwd = repoDir ?? this.defaultCwd;

    let diffText = "";
    try {
      // Try fetching diff via gh pr diff
      const { stdout } = await this.execGh(["pr", "diff", prReference], cwd);
      diffText = stdout;
    } catch {
      // Fallback: try git diff against origin/main or HEAD~1
      try {
        const { stdout } = await this.execGit(["diff", "origin/main...HEAD"], cwd);
        diffText = stdout;
      } catch {
        const { stdout } = await this.execGit(["diff", "HEAD~1...HEAD"], cwd);
        diffText = stdout;
      }
    }

    const issues: PrReviewIssue[] = [];

    // Analyze diff for anti-patterns and regressions
    const diffLines = diffText.split("\n");
    let currentFile = "";
    let lineNumber = 0;

    for (const line of diffLines) {
      if (line.startsWith("diff --git")) {
        const parts = line.split(" ");
        currentFile = parts[parts.length - 1]?.replace(/^[ab]\//, "") || "unknown";
        lineNumber = 0;
      } else if (line.startsWith("@@")) {
        const m = /\+(\d+)/.exec(line);
        if (m) lineNumber = parseInt(m[1], 10);
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        lineNumber++;
        const content = line.slice(1);

        // Rule 1: Flag hardcoded secrets or API keys
        if (/api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i.test(content) || /sk-[a-zA-Z0-9]{20,}/.test(content)) {
          issues.push({
            file: currentFile,
            line: lineNumber,
            severity: "critical",
            comment: "Potential hardcoded API key or credential detected. Use VaultStore or environment secrets instead.",
          });
        }

        // Rule 2: Flag console.log in non-test files
        if (content.includes("console.log(") && !currentFile.includes("test")) {
          issues.push({
            file: currentFile,
            line: lineNumber,
            severity: "warning",
            comment: "Avoid leaving raw console.log statements in production code. Use logger or remove before landing.",
          });
        }

        // Rule 3: Flag @ts-ignore or any bypasses (Rule 4 violation)
        if (content.includes("@ts-ignore") || content.includes("eslint-disable") || content.includes(": any")) {
          issues.push({
            file: currentFile,
            line: lineNumber,
            severity: "warning",
            comment: "Type assertion bypass detected (@ts-ignore or any). Ensure types are verified from ground truth.",
          });
        }
      }
    }

    const hasCritical = issues.some((i) => i.severity === "critical");
    const hasWarnings = issues.some((i) => i.severity === "warning");

    const verdict: "APPROVED" | "CHANGES_REQUESTED" | "COMMENT" = hasCritical
      ? "CHANGES_REQUESTED"
      : hasWarnings
      ? "COMMENT"
      : "APPROVED";

    const summary = verdict === "APPROVED"
      ? `PR diff for ${prReference} looks clean and well-structured. Zero critical violations found.`
      : verdict === "CHANGES_REQUESTED"
      ? `Found ${issues.filter((i) => i.severity === "critical").length} critical issue(s) in PR ${prReference}. Changes requested.`
      : `Found ${issues.length} suggestion(s) / non-critical warning(s) in PR ${prReference}.`;

    return {
      prReference,
      verdict,
      summary,
      issues,
      rawDiffSnippet: diffText.slice(0, 1000),
    };
  }

  /**
   * List all active Git worktrees (Claude Code Desktop & Codex Worktree Isolation Parity).
   */
  async listWorktrees(cwd?: string): Promise<GitWorktreeEntry[]> {
    try {
      const { stdout } = await this.execGit(["worktree", "list", "--porcelain"], cwd);
      const entries: GitWorktreeEntry[] = [];
      const blocks = stdout.split("\n\n").filter((b) => b.trim().length > 0);

      for (const block of blocks) {
        const lines = block.split("\n");
        let wtPath = "";
        let wtHead = "";
        let wtBranch = "";
        let isBare = false;

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            wtPath = line.replace("worktree ", "").trim();
          } else if (line.startsWith("HEAD ")) {
            wtHead = line.replace("HEAD ", "").trim();
          } else if (line.startsWith("branch ")) {
            wtBranch = line.replace("branch ", "").replace("refs/heads/", "").trim();
          } else if (line === "bare") {
            isBare = true;
          }
        }

        if (wtPath) {
          entries.push({
            path: wtPath,
            head: wtHead,
            branch: wtBranch || "detached",
            isBare,
          });
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Remove an isolated Git worktree and prune worktree metadata.
   */
  async removeWorktree(targetPath: string, cwd?: string): Promise<boolean> {
    const resolvedPath = path.resolve(targetPath);
    try {
      await this.execGit(["worktree", "remove", "--force", resolvedPath], cwd);
      await this.execGit(["worktree", "prune"], cwd);
      return true;
    } catch {
      return false;
    }
  }
}
