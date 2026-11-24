import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { AgentCoordinator } from "../src/coordinator.js";
import type { ExternalEngineConfig } from "../src/engines/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, __dirname.includes(`${path.sep}dist${path.sep}`) || __dirname.endsWith(`${path.sep}dist`) ? "../.." : "..");
const fakesDir = path.resolve(pkgRoot, "test/fixtures/engines/fakes");

/** One row per enabled slice. Every row uses a fake binary; no real engine or paid call is made. */
interface EngineSlice {
  engine: ExternalEngineConfig["engine"];
  label: string;
  fake: string;
  reply: RegExp;
  resumeReply?: RegExp;
  resumeInLog?: (log: any) => boolean;
  /** Interactive permission denial (engines with a stdio approval protocol). */
  denial?: { prompt: string; reply: RegExp; noFile?: string };
  /** How read-only intent is enforced when the engine has no interactive approval. */
  planCheck: (log: any) => boolean;
  /** OS-level hold of a read-only run (macOS, held engines only). */
  osHold?: { prompt: string; reply: RegExp };
}

function runSliceSuite(slice: EngineSlice): void {
  const fakeBin = path.join(fakesDir, slice.fake);

  describe(`${slice.label} external engine (fake only)`, () => {
    let tempDir: string;
    let workspaceDir: string;
    let sessionsDir: string;
    let daemon: LocalExecDaemon;
    let logPath: string;

    before(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `opensand-${slice.engine}-test-`));
      workspaceDir = path.join(tempDir, "workspace");
      sessionsDir = path.join(tempDir, "sessions");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(sessionsDir, { recursive: true });
      daemon = new LocalExecDaemon({ stateDir: path.join(tempDir, "state"), heartbeatIntervalMs: 200 });
      await daemon.start();
    });

    after(async () => {
      delete process.env.FAKE_LOG;
      await daemon.stop();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    const readLog = async () => JSON.parse(await fs.readFile(logPath, "utf8"));
    const newLog = () => {
      logPath = path.join(tempDir, `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      process.env.FAKE_LOG = logPath;
    };

    const coordinator = (sessionId: string, extra: Partial<ExternalEngineConfig> = {}, onApprovalRequired?: () => Promise<boolean>) =>
      new AgentCoordinator({
        daemon,
        sessionId,
        sessionsBaseDir: sessionsDir,
        workspaceDir,
        engineConfig: { type: "external", engine: slice.engine, binaryPath: fakeBin, ...extra },
        onApprovalRequired,
      });

    it("completes a turn and streams the fake reply", async () => {
      newLog();
      const deltas: string[] = [];
      const coord = new AgentCoordinator({
        daemon,
        sessionId: `slice_${slice.engine}_happy`,
        sessionsBaseDir: sessionsDir,
        workspaceDir,
        engineConfig: { type: "external", engine: slice.engine, binaryPath: fakeBin },
        onEvent: (event: any) => { if (event.type === "text_delta") deltas.push(event.text); },
      });
      const reply = await coord.runTurn("hello");
      assert.match(reply, slice.reply);
      assert.match(deltas.join(""), slice.reply);
    });

    it("resumes the same engine session on a second turn", async () => {
      newLog();
      const sessionId = `slice_${slice.engine}_resume`;
      const coord = coordinator(sessionId);
      await coord.runTurn("turn 1");
      const reply2 = await coord.runTurn("turn 2");
      if (slice.resumeReply) assert.match(reply2, slice.resumeReply);
      if (slice.resumeInLog) assert.equal(slice.resumeInLog(await readLog()), true, "resume id was not passed to the engine");
    });

    it("gives a plain next step when the binary is missing", async () => {
      const coord = new AgentCoordinator({
        daemon,
        sessionId: `slice_${slice.engine}_missing`,
        sessionsBaseDir: sessionsDir,
        workspaceDir,
        engineConfig: { type: "external", engine: slice.engine, binaryPath: path.join(tempDir, "no-such-binary") },
      });
      await assert.rejects(coord.runTurn("hello"), (err: any) => {
        assert.match(err.message, new RegExp(`Install ${slice.label}`));
        assert.doesNotMatch(err.message, /^\s*at\s+/m);
        return true;
      });
    });

    it("gives a plain not-signed-in message when the fake exits unauthenticated", async () => {
      const coord = coordinator(`slice_${slice.engine}_auth`);
      await assert.rejects(coord.runTurn("FAIL_AUTH"), (err: any) => {
        assert.match(err.message, /not signed in/i);
        assert.doesNotMatch(err.message, /Error: not logged in/);
        return true;
      });
    });

    it("cancels a hung turn and kills the child process group", async () => {
      newLog();
      const coord = coordinator(`slice_${slice.engine}_cancel`);
      const ac = new AbortController();
      const pending = coord.runTurn("HANG", ac.signal);
      let pid: number | undefined;
      for (let i = 0; i < 40; i++) {
        try {
          const log = await readLog();
          if (log.pid) { pid = log.pid; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(pid, "fake engine did not record a pid");
      assert.doesNotThrow(() => process.kill(pid!, 0));
      ac.abort();
      await assert.rejects(pending, (err: any) => err.name === "AbortError" || /cancel/i.test(err.message));
      let dead = false;
      for (let i = 0; i < 40; i++) {
        try { process.kill(pid!, 0); await new Promise((r) => setTimeout(r, 50)); }
        catch (err: any) { if (err?.code === "ESRCH") { dead = true; break; } }
      }
      assert.equal(dead, true, `child ${pid} survived the abort`);
    });

    it("denies a mutation when no approver is attached or plan mode is set", async () => {
      newLog();
      if (slice.denial) {
        const coord = coordinator(`slice_${slice.engine}_deny`, {}, async () => false);
        const reply = await coord.runTurn(slice.denial.prompt);
        assert.match(reply, slice.denial.reply);
        if (slice.denial.noFile) {
          await assert.rejects(fs.access(path.join(workspaceDir, slice.denial.noFile)));
        }
      } else {
        const coord = coordinator(`slice_${slice.engine}_plan`, { mode: "plan" });
        await coord.runTurn("read only");
        assert.equal(slice.planCheck(await readLog()), true, "read-only intent was not enforced");
      }
    });

    if (slice.osHold) {
      it("holds a read-only turn in the OS sandbox", async () => {
        newLog();
        const coord = coordinator(`slice_${slice.engine}_hold`, { mode: "plan" });
        const reply = await coord.runTurn(slice.osHold!.prompt);
        assert.match(reply, slice.osHold!.reply);
      });
    }
  });
}

runSliceSuite({
  engine: "opencode",
  label: "OpenCode",
  fake: "opencode",
  reply: /hello from opencode/,
  resumeInLog: (log) => Boolean(log.rpc?.some((e: any) => e.method === "session/load")),
  denial: { prompt: "ASK_WRITE", reply: /ASK_RESULT:reject/, noFile: "acp-wrote.txt" },
  planCheck: (log) => Boolean(log.rpc?.some((e: any) => e.method === "session/set_config_option" && e.configId === "mode" && e.value === "plan")),
  osHold: { prompt: "TRY_WRITE", reply: /TRY_WRITE:EPERM/ },
});
