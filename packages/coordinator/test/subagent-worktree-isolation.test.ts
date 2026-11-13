import * as http from "node:http";
import { execFileSync } from "node:child_process";
import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { AgentStore } from "../src/agent-store.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";

/**
 * Per-agent isolation: two writing subagents that target the same file must
 * not collide on disk. Each runs in its own Git worktree on its own branch;
 * the base tree stays untouched and the worktrees are pruned afterwards.
 */

function git(args: string[], cwd: string): string {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    delete env[k];
  }
  return execFileSync("git", args, { cwd, env, encoding: "utf-8" });
}

function createRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["config", "user.email", "p4d@example.com"], dir);
  git(["config", "user.name", "P4D Test"], dir);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "base content\n", "utf-8");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function contentChunk(text: string): unknown {
  return { choices: [{ delta: { content: text }, finish_reason: "stop" }] };
}

function toolCallChunk(command: string): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "exec_command", arguments: JSON.stringify({ command }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/**
 * Mock LLM. The first request of a writing agent gets an exec_command that
 * appends its own line; every follow-up request answers with plain content.
 */
function startMockLlm(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let messages: any[] = [];
      try {
        messages = JSON.parse(body || "{}").messages ?? [];
      } catch {
        messages = [];
      }
      const hasToolResult = messages.some((m) => m.role === "tool");
      const taskText = messages
        .filter((m) => m.role === "user")
        .map((m) => String(m.content ?? ""))
        .join("\n");

      let command: string | null = null;
      if (taskText.includes("agent A")) {
        command = "printf 'change from agent A\\n' >> tracked.txt";
      } else if (taskText.includes("agent B")) {
        command = "printf 'change from agent B\\n' >> tracked.txt";
      }

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!command || hasToolResult) {
        res.end(sse(contentChunk("Subagent done.")) + "data: [DONE]\n\n");
      } else {
        res.end(sse(toolCallChunk(command)) + "data: [DONE]\n\n");
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("delegate_to_agent isolates writing subagents in separate Git worktrees", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p4d-isolation-"));
  const repoDir = path.join(tmpDir, "repo");
  const nonGitDir = path.join(tmpDir, "not-a-repo");
  fs.mkdirSync(nonGitDir, { recursive: true });
  createRepo(repoDir);

  const baseHeadBefore = git(["rev-parse", "HEAD"], repoDir).trim();
  const llm = await startMockLlm();

  const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
  await daemon.start();
  await daemon.state.writePermissionGates({ computerUseAllowed: true });

  try {
    const store = new AgentStore(path.join(tmpDir, "agents"));
    registerOrchestratorTools({
      daemon,
      store,
      repoRoot: repoDir,
      defaultEndpoint: `http://127.0.0.1:${llm.port}/v1`,
      defaultModel: "mock-subagent-model",
      sessionsBaseDir: path.join(tmpDir, "sessions"),
    });

    const agentA = await store.createAgent({
      name: "Agent A",
      role: "Software Engineer",
      systemPrompt: "Append your line to tracked.txt.",
      allowedTools: ["exec_command"],
    });
    const agentB = await store.createAgent({
      name: "Agent B",
      role: "Software Engineer",
      systemPrompt: "Append your line to tracked.txt.",
      allowedTools: ["exec_command"],
    });
    const reader = await store.createAgent({
      name: "Reader",
      role: "Software Engineer",
      systemPrompt: "Only read.",
      allowedTools: ["read_file"],
    });

    // 1. Two writing subagents in parallel against the same file.
    const [resA, resB] = await Promise.all([
      daemon.executeTool("delegate_to_agent", {
        agent_id_or_name: agentA.id,
        task: "Append the agent A line to tracked.txt",
      }),
      daemon.executeTool("delegate_to_agent", {
        agent_id_or_name: agentB.id,
        task: "Append the agent B line to tracked.txt",
      }),
    ]);

    assert.strictEqual(resA.status, "ok");
    assert.strictEqual(resB.status, "ok");
    const payloadA = JSON.parse(resA.output as string);
    const payloadB = JSON.parse(resB.output as string);
    assert.strictEqual(payloadA.status, "completed");
    assert.strictEqual(payloadB.status, "completed");

    // 2. Both ran in their own worktree, on their own branch.
    assert.strictEqual(payloadA.isolation.isolation, "worktree");
    assert.strictEqual(payloadB.isolation.isolation, "worktree");
    assert.match(payloadA.isolation.branch, /^subagent\/agent-a-/);
    assert.match(payloadB.isolation.branch, /^subagent\/agent-b-/);
    assert.notStrictEqual(payloadA.isolation.branch, payloadB.isolation.branch);
    assert.strictEqual(payloadA.isolation.cleanedUp, true);
    assert.strictEqual(payloadB.isolation.cleanedUp, true);

    // 3. The base working tree is untouched and nothing was merged.
    assert.strictEqual(
      fs.readFileSync(path.join(repoDir, "tracked.txt"), "utf-8"),
      "base content\n"
    );
    assert.strictEqual(git(["rev-parse", "HEAD"], repoDir).trim(), baseHeadBefore);

    // 4. Each subagent's work landed on its own branch, with a diff summary.
    assert.ok(payloadA.isolation.diff.filesChanged >= 1);
    assert.match(payloadA.isolation.diff.diff, /change from agent A/);
    assert.match(payloadB.isolation.diff.diff, /change from agent B/);
    assert.ok(
      git(["branch", "--list", payloadA.isolation.branch], repoDir).includes(
        payloadA.isolation.branch
      ),
      "agent A branch must exist after the worktree was pruned"
    );
    assert.ok(
      git(["branch", "--list", payloadB.isolation.branch], repoDir).includes(
        payloadB.isolation.branch
      ),
      "agent B branch must exist after the worktree was pruned"
    );

    // 5. Both worktrees were pruned from disk.
    assert.strictEqual(fs.existsSync(payloadA.isolation.worktreePath), false);
    assert.strictEqual(fs.existsSync(payloadB.isolation.worktreePath), false);
    const worktreeList = git(["worktree", "list", "--porcelain"], repoDir);
    assert.strictEqual(
      worktreeList.split("\n").filter((l) => l.startsWith("worktree ")).length,
      1,
      "only the base worktree may remain"
    );

    // 6. A read-only agent runs without any worktree.
    const beforeReader = git(["worktree", "list", "--porcelain"], repoDir);
    const readerRes = await daemon.executeTool("delegate_to_agent", {
      agent_id_or_name: reader.id,
      task: "Read tracked.txt",
    });
    assert.strictEqual(readerRes.status, "ok");
    const readerPayload = JSON.parse(readerRes.output as string);
    assert.strictEqual(readerPayload.status, "completed");
    assert.strictEqual(readerPayload.isolation.isolation, "none");
    assert.strictEqual(git(["worktree", "list", "--porcelain"], repoDir), beforeReader);

    // 7. Requesting worktree isolation outside a Git repository is refused.
    const nonGitDaemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state-non-git") });
    await nonGitDaemon.start();
    await nonGitDaemon.state.writePermissionGates({ computerUseAllowed: true });
    try {
      registerOrchestratorTools({
        daemon: nonGitDaemon,
        store,
        repoRoot: nonGitDir,
        defaultEndpoint: `http://127.0.0.1:${llm.port}/v1`,
        defaultModel: "mock-subagent-model",
        sessionsBaseDir: path.join(tmpDir, "sessions"),
      });
      const refused = await nonGitDaemon.executeTool("delegate_to_agent", {
        agent_id_or_name: agentA.id,
        task: "Append the agent A line to tracked.txt",
        isolation: "worktree",
      });
      assert.strictEqual(refused.status, "error");
      assert.match(refused.error?.message ?? "", /not a Git repository/);
    } finally {
      await nonGitDaemon.stop();
    }
  } finally {
    await daemon.stop();
    await llm.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
