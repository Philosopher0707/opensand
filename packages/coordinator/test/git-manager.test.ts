import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitManager } from "../src/git-manager.js";

const execFileAsync = promisify(execFile);

/** Strip ambient GIT_* variables so inner git commands target the temp repo,
 * not an enclosing repo (prevents the outer pre-commit hook from recursing). */
function gitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>) };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES"]) {
    delete env[k];
  }
  return env as NodeJS.ProcessEnv;
}

describe("GitManager", () => {
  let tempRepoDir: string;
  let gitManager: GitManager;

  beforeEach(async () => {
    tempRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-git-test-"));
    // Initialize temporary git repo
    await execFileAsync("git", ["init", "-b", "main"], { cwd: tempRepoDir, env: gitEnv() });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: tempRepoDir, env: gitEnv() });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempRepoDir, env: gitEnv() });

    // Initial commit
    await fs.writeFile(path.join(tempRepoDir, "README.md"), "# Test Repo\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: tempRepoDir, env: gitEnv() });
    await execFileAsync("git", ["commit", "-m", "chore: initial commit"], { cwd: tempRepoDir, env: gitEnv() });

    gitManager = new GitManager(tempRepoDir);
  });

  afterEach(async () => {
    await fs.rm(tempRepoDir, { recursive: true, force: true });
  });

  it("reports accurate repository status", async () => {
    const initialStatus = await gitManager.getStatus();
    assert.strictEqual(initialStatus.branch, "main");
    assert.strictEqual(initialStatus.isClean, true);

    // Create a new file
    await fs.writeFile(path.join(tempRepoDir, "newfile.txt"), "hello world");
    const untrackedStatus = await gitManager.getStatus();
    assert.strictEqual(untrackedStatus.isClean, false);
    assert.strictEqual(untrackedStatus.untracked.length, 1);
    assert.strictEqual(untrackedStatus.untracked[0], "newfile.txt");

    // Stage it
    await execFileAsync("git", ["add", "newfile.txt"], { cwd: tempRepoDir, env: gitEnv() });
    const stagedStatus = await gitManager.getStatus();
    assert.strictEqual(stagedStatus.staged.length, 1);
    assert.strictEqual(stagedStatus.staged[0], "newfile.txt");
  });

  it("computes diff and diff statistics", async () => {
    await fs.appendFile(path.join(tempRepoDir, "README.md"), "Line 2 added\nLine 3 added\n");

    const diff = await gitManager.getDiff();
    assert.ok(diff.diff.includes("+Line 2 added"));
    assert.strictEqual(diff.filesChanged, 1);
    assert.strictEqual(diff.insertions, 2);
  });

  it("stages and creates auto-commits with conventional formatting", async () => {
    await fs.writeFile(path.join(tempRepoDir, "feature.ts"), "export const x = 10;\n");

    const commit = await gitManager.autoCommit("feat: add feature module");
    assert.strictEqual(commit.branch, "main");
    assert.strictEqual(commit.message, "feat: add feature module");
    assert.ok(commit.commitHash.length >= 7);

    const statusAfter = await gitManager.getStatus();
    assert.strictEqual(statusAfter.isClean, true);
  });

  it("excludes sensitive secret files (.env, *.pem, *.key) from autoCommit staging", async () => {
    // Create a valid source file and sensitive files
    await fs.writeFile(path.join(tempRepoDir, "safe.ts"), "export const safe = true;\n");
    await fs.writeFile(path.join(tempRepoDir, ".env"), "SECRET_API_KEY=xyz123\n");
    await fs.writeFile(path.join(tempRepoDir, "server.key"), "PRIVATE_KEY_DATA\n");
    await fs.writeFile(path.join(tempRepoDir, "cert.pem"), "CERT_DATA\n");

    const commit = await gitManager.autoCommit("feat: add safe code");
    assert.strictEqual(commit.branch, "main");

    // safe.ts should be committed, but .env, server.key, cert.pem must remain untracked!
    const status = await gitManager.getStatus();
    assert.strictEqual(status.isClean, false);
    assert.strictEqual(status.staged.length, 0);
    assert.ok(status.untracked.includes(".env"), ".env must remain untracked");
    assert.ok(status.untracked.includes("server.key"), "server.key must remain untracked");
    assert.ok(status.untracked.includes("cert.pem"), "cert.pem must remain untracked");
    assert.strictEqual(status.untracked.includes("safe.ts"), false, "safe.ts must have been committed");
  });

  it("reviews PR diffs and flags critical security issues, console logs, and bypasses", async () => {
    // Add problematic lines to branch
    await fs.writeFile(
      path.join(tempRepoDir, "auth.ts"),
      `export const key = "sk-1234567890123456789012345";\nconsole.log(key);\nconst val: any = 1;\n`
    );
    await execFileAsync("git", ["add", "-A"], { cwd: tempRepoDir, env: gitEnv() });
    await execFileAsync("git", ["commit", "-m", "feat: auth updates"], { cwd: tempRepoDir, env: gitEnv() });

    const review = await gitManager.reviewPullRequest("HEAD");
    assert.strictEqual(review.verdict, "CHANGES_REQUESTED");
    assert.ok(review.issues.length >= 3);

    const critical = review.issues.find((i) => i.severity === "critical");
    assert.ok(critical);
    assert.ok(critical?.comment.includes("hardcoded API key"));

    const warnings = review.issues.filter((i) => i.severity === "warning");
    assert.ok(warnings.some((w) => w.comment.includes("console.log")));
    assert.ok(warnings.some((w) => w.comment.includes("Type assertion bypass")));
  });
});
