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

  it("(a) surfaces plain next-step message when claude binary is missing or version is too old", async () => {
    // 1. Missing binary
    const coordMissing = new AgentCoordinator({
      daemon,
      sessionId: `test_missing_${Date.now()}`,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: path.join(tempDir, "nonexistent-claude-bin"),
      },
    });

    await assert.rejects(coordMissing.runTurn("hello"), (err: any) => {
      assert.match(err.message, /Install Claude Code/);
      assert.doesNotMatch(err.message, /^\s*at\s+/m);
      return true;
    });

    // 2. Version too old
    const oldClaudeBin = path.join(tempDir, "fake-claude-old");
    await fs.writeFile(
      oldClaudeBin,
      `#!/usr/bin/env node\nif (process.argv.slice(2)[0] === "--version") { console.log("1.0.0 (Claude Code)"); process.exit(0); }\n`,
      { mode: 0o755 }
    );

    const coordOld = new AgentCoordinator({
      daemon,
      sessionId: `test_old_${Date.now()}`,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: oldClaudeBin,
      },
    });

    await assert.rejects(coordOld.runTurn("hello"), (err: any) => {
      assert.match(err.message, /Update Claude Code to/);
      assert.doesNotMatch(err.message, /^\s*at\s+/m);
      return true;
    });
  });

  it("(c) handles engine crash / non-zero exit mid-turn and allows subsequent message on same session to succeed", async () => {
    const sessionId = `test_crash_${Date.now()}`;
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

    // Turn 1 crashes mid-turn
    await assert.rejects(coordinator.runTurn("CRASH_MID_TURN"), (err: any) => {
      assert.match(err.message, /Claude Code stopped unexpectedly/);
      assert.match(err.message, /send another message/i);
      assert.doesNotMatch(err.message, /^\s*at\s+/m);
      return true;
    });

    // Turn 2 on the same session succeeds
    const reply2 = await coordinator.runTurn("turn 2 after crash");
    assert.match(reply2, /continued sess-claude-1/);
  });

  it("(d) stops turn with a plain message when no output received before timeoutMs", async () => {
    const sessionId = `test_timeout_${Date.now()}`;
    const coordinator = new AgentCoordinator({
      daemon,
      sessionId,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
        timeoutMs: 250,
      },
    });

    await assert.rejects(coordinator.runTurn("SLOW_SILENT"), (err: any) => {
      assert.match(err.message, /timed out/i);
      assert.match(err.message, /try/i);
      assert.doesNotMatch(err.message, /^\s*at\s+/m);
      return true;
    });
  });

  it("(e) aborts turn cleanly and verifies child process is terminated via ESRCH", async () => {
    const sessionId = `test_abort_${Date.now()}`;
    const fakeLog = path.join(tempDir, `fake-abort-${Date.now()}.json`);
    process.env.FAKE_LOG = fakeLog;

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

    // Wait for the fake engine process to spawn and write its PID to FAKE_LOG
    let childPid;
    for (let i = 0; i < 20; i++) {
      try {
        if (await fs.stat(fakeLog).then(() => true).catch(() => false)) {
          const raw = JSON.parse(await fs.readFile(fakeLog, "utf-8"));
          if (raw.pid) {
            childPid = raw.pid;
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(childPid, "Child PID should have been recorded in FAKE_LOG");

    // Verify child is alive before abort
    assert.doesNotThrow(() => {
      process.kill(childPid, 0);
    }, "Child process should be running before abort");

    ac.abort();

    await assert.rejects(turnPromise, (err: any) => {
      return err.name === "AbortError" || /cancelled/i.test(err.message);
    });

    // Verify process is killed and ESRCH is thrown
    let dead = false;
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        if (err && (err as any).code === "ESRCH") {
          dead = true;
          break;
        }
      }
    }
    assert.strictEqual(dead, true, `Process ${childPid} should have terminated with ESRCH`);
    assert.throws(() => {
      process.kill(childPid, 0);
    }, (err: any) => err && err.code === "ESRCH");

    delete process.env.FAKE_LOG;
  });

  it("(f) reports user-friendly usage/rate limit with reset time or fallback", async () => {
    // 1. With reset time
    const coordWithTime = new AgentCoordinator({
      daemon,
      sessionId: `test_rate_time_${Date.now()}`,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
      },
    });

    await assert.rejects(coordWithTime.runTurn("FAIL_RATE_LIMIT_TIME"), (err: any) => {
      assert.match(err.message, /Claude usage limit reached, resets at 3:00 PM/);
      assert.match(err.message, /Settings|try again/i);
      assert.doesNotMatch(err.message, /^\s*at\s+/m);
      return true;
    });

    // 2. Without reset time
    const coordNoTime = new AgentCoordinator({
      daemon,
      sessionId: `test_rate_notime_${Date.now()}`,
      sessionsBaseDir: sessionsDir,
      workspaceDir,
      engineConfig: {
        type: "external",
        engine: "claude",
        binaryPath: fakeClaudeBin,
      },
    });

    await assert.rejects(coordNoTime.runTurn("FAIL_RATE_LIMIT_NO_TIME"), (err: any) => {
      assert.match(err.message, /Claude usage limit reached/);
      assert.match(err.message, /try again later/);
      assert.doesNotMatch(err.message, /^\s*at\s+/m);
      return true;
    });
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
