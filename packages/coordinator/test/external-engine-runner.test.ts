import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { AgentCoordinator } from "../src/coordinator.js";
import { ExternalEngineTurnRunner, detectEngines } from "../src/engines/external-engine-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, __dirname.includes(`${path.sep}dist${path.sep}`) || __dirname.endsWith(`${path.sep}dist`) ? "../.." : "..");
const fakeClaudeBin = path.resolve(pkgRoot, "test/fixtures/engines/fakes/claude");

describe("ExternalEngineTurnRunner & AgentCoordinator external engine integration", () => {
  let tempDir: string;
  let workspaceDir: string;
  let sessionsDir: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-ext-engine-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    daemon = new LocalExecDaemon({
      stateDir: path.join(tempDir, "state"),
      heartbeatIntervalMs: 200,
    });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("completes a fake Claude turn and writes messages.json and transcript projections", async () => {
    const sessionId = `test_session_${Date.now()}_1`;
    const coordinator = new AgentCoordinator({
      daemon,
      sessionId,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
      },
    });

    const reply = await coordinator.runTurn("hello from claude");
    assert.match(reply, /hello from claude/);

    const sessionFolder = path.join(sessionsDir, sessionId);
    const messagesPath = path.join(sessionFolder, "messages.json");
    const transcriptTxtPath = path.join(sessionFolder, "transcript.txt");
    const transcriptJsonlPath = path.join(sessionFolder, "transcript.jsonl");

    const messagesRaw = await fs.readFile(messagesPath, "utf-8");
    const messages = JSON.parse(messagesRaw);
    assert.strictEqual(Array.isArray(messages), true);
    assert.strictEqual(messages.length >= 2, true);
    assert.strictEqual(messages[messages.length - 2].role, "user");
    assert.strictEqual(messages[messages.length - 2].content, "hello from claude");
    assert.strictEqual(messages[messages.length - 1].role, "assistant");
    assert.match(messages[messages.length - 1].content, /hello from claude/);

    const txtContent = await fs.readFile(transcriptTxtPath, "utf-8");
    assert.match(txtContent, /hello from claude/);

    const jsonlContent = await fs.readFile(transcriptJsonlPath, "utf-8");
    assert.match(jsonlContent, /hello from claude/);
  });

  it("resumes using the stored engine session id", async () => {
    const sessionId = `test_session_${Date.now()}_resume`;
    const coordinator = new AgentCoordinator({
      daemon,
      sessionId,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
      },
    });

    const reply1 = await coordinator.runTurn("turn 1");
    assert.match(reply1, /hello from claude/);

    // Verify metadata has externalEngine sessionId
    const metaPath = path.join(sessionsDir, sessionId, "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    assert.strictEqual(meta.externalEngine?.engine, "claude");
    assert.strictEqual(meta.externalEngine?.sessionId, "sess-claude-1");

    // Run turn 2 on the same session
    const reply2 = await coordinator.runTurn("turn 2");
    assert.match(reply2, /continued sess-claude-1/);
  });

  it("denies Write in plan mode and in ask mode when rejected", async () => {
    // 1. Plan mode
    const sessionPlan = `test_plan_${Date.now()}`;
    const coordPlan = new AgentCoordinator({
      daemon,
      sessionId: sessionPlan,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
        mode: "plan",
      },
    });

    const replyPlan = await coordPlan.runTurn("ASK_WRITE");
    assert.strictEqual(replyPlan, "ASK_RESULT:Write:deny");
    const writePlanTarget = path.join(workspaceDir, "ask-write.txt");
    let planFileExists = false;
    try {
      await fs.access(writePlanTarget);
      planFileExists = true;
    } catch {}
    assert.strictEqual(planFileExists, false, "ask-write.txt must not exist in plan mode");

    // 2. Ask mode with approver returning false
    const sessionAsk = `test_ask_${Date.now()}`;
    const coordAsk = new AgentCoordinator({
      daemon,
      sessionId: sessionAsk,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
        mode: "agent",
      },
      onApprovalRequired: async () => false,
    });

    const replyAsk = await coordAsk.runTurn("ASK_WRITE");
    assert.strictEqual(replyAsk, "ASK_RESULT:Write:deny");
    let askFileExists = false;
    try {
      await fs.access(writePlanTarget);
      askFileExists = true;
    } catch {}
    assert.strictEqual(askFileExists, false, "ask-write.txt must not exist when rejected");
  });

  it("denies when no approver is provided (fail closed)", async () => {
    const sessionId = `test_no_appr_${Date.now()}`;
    const coordinator = new AgentCoordinator({
      daemon,
      sessionId,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
        mode: "agent",
      },
      // onApprovalRequired is omitted -> must fail closed
    });

    const reply = await coordinator.runTurn("ASK_WRITE");
    assert.strictEqual(reply, "ASK_RESULT:Write:deny");
  });

  it("aborts turn cleanly and leaves no lingering processes", async () => {
    const sessionId = `test_abort_${Date.now()}`;
    const coordinator = new AgentCoordinator({
      daemon,
      sessionId,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
      },
    });

    const ac = new AbortController();
    const turnPromise = coordinator.runTurn("HANG", ac.signal);
    setTimeout(() => ac.abort(), 100);

    await assert.rejects(turnPromise, (err: any) => {
      return err.name === "AbortError" || /cancelled/i.test(err.message);
    });

    // Verify no lingering process with the fake claude script
    await new Promise((r) => setTimeout(r, 200));
    const ps = execSync("ps aux | grep fakes/claude | grep -v grep || true", { encoding: "utf-8" });
    assert.strictEqual(ps.trim(), "", "No lingering fake claude process should be left");
  });

  it("surfaces explainError text on sign-in / authentication failure", async () => {
    const sessionId = `test_auth_${Date.now()}`;
    const coordinator = new AgentCoordinator({
      daemon,
      sessionId,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
      },
    });

    await assert.rejects(coordinator.runTurn("FAIL_AUTH"), (err: any) => {
      assert.match(err.message, /Claude Code is not signed in/i);
      assert.match(err.message, /claude login/i);
      return true;
    });
  });

  it("guarantees zero bypass flags in packages/coordinator/src/engines", () => {
    const enginesDir = path.resolve(pkgRoot, "src/engines");
    const grepCmd = "grep -rnE \"bypassPermissions|dangerously-skip|danger-full-access|allow-all-tools|--yolo\" " + enginesDir + " || true";
    const result = execSync(grepCmd, { encoding: "utf-8" }).trim();
    assert.strictEqual(result, "", `Expected zero bypass flags in engines, but found:\n${result}`);
  });
});
