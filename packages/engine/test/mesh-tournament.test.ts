/**
 * Phase 7 tournament runner tests (docs/design/phase7-mesh-tournament.md §10 S4).
 *
 * End-to-end over real git worktrees and a real check command against the
 * HTTP stub provider, plus the §6 refusals, the write-once decision, the
 * kill -9 reconcile path and the §7 containment fixture.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EventLogReader } from "@opensand/shared";
import { AttemptWorktrees, buildSandboxedSpawn } from "@opensand/local-exec-daemon";
import {
  startTournament,
  reconcileTournament,
  settleMeshDecision,
  openAiCompatProvider,
  resolveTournamentLimits,
  type ModelCatalog,
  type TournamentStartOptions,
} from "../src/mesh/tournament.js";
import { parseRoutesConfig } from "../src/mesh/routes-schema.js";
import type { MeshDecision } from "../src/mesh/judge.js";
import { StubProvider, chatResponse, writesContent } from "./fixtures/stub-provider.js";

const execGit = promisify(execFile);

const isDarwin = process.platform === "darwin";
const SKIPPED = isDarwin ? false : "sandbox containment fixture runs on darwin (repo pattern: sandbox-macos.test.ts)";

/** The synthetic launcher tests inject: the runner never spawns through it. */
const TEST_LAUNCHER = { kind: "sandbox-exec", path: "/usr/bin/sandbox-exec" } as const;

interface Setup {
  repoRoot: string;
  stateDir: string;
  missionId: string;
  missionDir: string;
  attemptsRoot: string;
  missionLogPath: string;
  baseCommit: string;
  git: (args: string[], cwd?: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function setup(missionId = "m-test"): Promise<Setup> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "s4-repo-"));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "s4-state-"));
  const missionDir = path.join(stateDir, "missions", missionId);
  const attemptsRoot = path.join(missionDir, "attempts");
  const git = async (args: string[], cwd: string = repoRoot): Promise<string> => {
    const { stdout } = await execGit("git", args, { cwd });
    return stdout;
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@opensand.local"]);
  await git(["config", "user.name", "OpenSand Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "base\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "base"]);
  const baseCommit = (await git(["rev-parse", "HEAD"])).trim();
  return {
    repoRoot,
    stateDir,
    missionId,
    missionDir,
    attemptsRoot,
    missionLogPath: path.join(missionDir, "event-log.jsonl"),
    baseCommit,
    git,
    cleanup: async () => {
      await fs.rm(repoRoot, { recursive: true, force: true });
      await fs.rm(stateDir, { recursive: true, force: true });
    },
  };
}

function routesFor(ladder: string[]) {
  return parseRoutesConfig({ version: 1, roles: { coder: { ladder, minSamples: 5, minPassRate: 0.5 } } });
}

/** $10/MTok in, $50/MTok out for every model unless overridden. */
function catalogFor(models: string[]): ModelCatalog {
  const catalog: ModelCatalog = {};
  for (const m of models) {
    catalog[m] = { family: `fam-${m}`, priceInUsdPerMTok: 10, priceOutUsdPerMTok: 50 };
  }
  return catalog;
}

function baseOptions(s: Setup, overrides: Partial<TournamentStartOptions>): TournamentStartOptions {
  return {
    missionId: s.missionId,
    repoRoot: s.repoRoot,
    stateDir: s.stateDir,
    task: "make the check pass",
    role: "coder",
    routes: routesFor(["stub:a", "stub:b"]),
    stats: new Map(),
    catalog: catalogFor(["stub:a", "stub:b"]),
    checkCommand: 'test "$(cat README.md)" != "wrong"',
    provider: { call: async () => ({ ok: false, errorKind: "network" }) },
    sandboxLauncher: TEST_LAUNCHER,
    ...overrides,
  };
}

async function dirCount(dir: string): Promise<number> {
  try {
    return (await fs.readdir(dir)).length;
  } catch {
    return 0; // the refused start never created it
  }
}

async function readMissionEvents(s: Setup): Promise<Array<{ kind: string; attempt?: number; data: any }>> {
  return (await new EventLogReader(s.missionLogPath).readAll()) as any;
}

async function worktreePaths(git: Setup["git"]): Promise<string[]> {
  const out = await git(["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

function meshResults(events: Array<{ kind: string; attempt?: number; data: any }>) {
  return events
    .filter((e) => e.kind === "mesh.attempt.result")
    .map((e) => ({ attempt: e.attempt, data: e.data }));
}

describe("mesh tournament runner (S4)", () => {
  it(
    "three attempts end to end: judge keeps the winner, losers are snapshotted and removed",
    { timeout: 60_000 },
    async () => {
      const s = await setup();
      const stub = new StubProvider({
        "stub:a": [
          // attempt 1 rung 0: wrong content -> check fails -> escalation
          chatResponse(writesContent({ "README.md": "wrong\n" }), { promptTokens: 100, completionTokens: 200 }),
          // attempt 2 rung 0: no writes -> check passes, diff 0 -> no_change
          chatResponse(writesContent({}), { promptTokens: 100, completionTokens: 200 }),
          // attempt 3 rung 0: 429 twice, then a good, larger change
          { status: 429, body: { error: "rate limited" } },
          { status: 429, body: { error: "rate limited" } },
          chatResponse(
            writesContent({ "README.md": "good\n", "extra.txt": "x\n".repeat(60) }),
            { promptTokens: 100, completionTokens: 200 },
          ),
        ],
        "stub:b": [
          // attempt 1 rung 1: the good change
          chatResponse(writesContent({ "README.md": "good\n" }), { promptTokens: 100, completionTokens: 200 }),
          // attempt 2 rung 1: out of credit -> parks, no retry
          { status: 402, body: { error: "out of credit" } },
        ],
      });
      const baseUrl = await stub.start();
      try {
        const run = await startTournament(
          baseOptions(s, {
            attempts: 3,
            concurrency: 1,
            provider: openAiCompatProvider(baseUrl),
            limits: { infraBackoffMs: [5, 5, 5] },
            review: (tied) =>
              JSON.stringify({ order: tied.map((t) => t.n), reason: "stub reviewer" }),
          }),
        );

        // Judge: attempts 1 and 3 passed and are inside the band; the reviewer broke the tie.
        assert.equal(run.status, "kept");
        assert.equal(run.winner, 1);
        assert.deepEqual(run.decision.eligible, [1, 3]);
        assert.deepEqual(run.decision.band, [1, 3]);
        assert.equal(run.decision.tieBreak, "reviewer");
        assert.match(run.decision.reviewerRaw ?? "", /stub reviewer/);

        // mesh.decision is in the mission log exactly once, write-once (§5.3).
        const events = await readMissionEvents(s);
        assert.equal(events.filter((e) => e.kind === "mesh.decision").length, 1);
        const started = events.find((e) => e.kind === "mesh.tournament.started")!;
        assert.equal(started.data.base, s.baseCommit);

        // mesh.route.selected (S5 §2.3): one record, with the chosen rung and
        // the input hash, written before the tournament it feeds.
        const routeIdx = events.findIndex((e) => e.kind === "mesh.route.selected");
        assert.ok(routeIdx >= 0, "mesh.route.selected is in the log");
        assert.ok(routeIdx < events.findIndex((e) => e.kind === "mesh.tournament.started"), "route choice comes first");
        const route = events[routeIdx]!;
        assert.equal(route.data.role, "coder");
        assert.equal(route.data.rung, 0);
        assert.equal(route.data.model, "stub:a");
        assert.equal(route.data.reason, "no-qualifying-record");
        assert.match(route.data.inputsHash, /^[0-9a-f]{64}$/);

        // One mesh.attempt.result per attempt, with the §3.1 shape.
        const results = meshResults(events);
        assert.deepEqual(results.map((r) => r.attempt), [1, 2, 3]);
        const [r1, r2, r3] = results.map((r) => r.data);
        assert.equal(r1.outcome, "passed");
        assert.equal(r1.model, "stub:b");
        assert.equal(r1.rung, 1);
        assert.equal(r1.escalatedFrom, "stub:a");
        assert.ok(r1.costUsd > 0);
        assert.ok(r1.tokensOut > 0);
        assert.equal(r2.outcome, "infra_error");
        assert.equal(r2.model, "stub:b"); // parked on rung 1 after the 402
        assert.equal(r2.rung, 1);
        assert.equal(r3.outcome, "passed");
        assert.equal(r3.model, "stub:a");
        assert.equal(r3.rung, 0);

        // model.call records: one per call including the two 429 retries,
        // ok calls carry usage and the response hash (P1 model.*).
        const calls = events.filter((e) => e.kind === "model.call");
        assert.equal(calls.length, 7); // 4 ok calls + 2×429 (attempt 3) + 1×402 (attempt 2)
        const okCalls = calls.filter((c) => c.data.status === "ok");
        assert.equal(okCalls.length, 4);
        for (const c of okCalls) {
          assert.match(c.data.contentSha256, /^[0-9a-f]{64}$/);
          assert.ok(c.data.usage);
          assert.ok(typeof c.data.costUsd === "number");
        }
        const errorCalls = calls.filter((c) => c.data.status === "error");
        assert.deepEqual(
          errorCalls.map((c) => c.data.httpStatus),
          [402, 429, 429],
        );

        // git worktree list: main + the kept one, and nothing under the attempts root.
        const wts = await worktreePaths(s.git);
        assert.equal(wts.length, 2, `expected main + kept, got ${wts.join(", ")}`);
        assert.equal(await dirCount(s.attemptsRoot), 0);
        assert.equal(run.keptBranch, "opensand/m-test/1");
        assert.ok(run.keptPath && run.keptPath.includes(path.join("kept", "1")));

        // The kept branch holds attempt 1's tree and nothing of attempt 3's.
        const keptReadme = await s.git(["cat-file", "-p", `${run.keptBranch}:README.md`]);
        assert.equal(keptReadme, "good\n");
        await assert.rejects(() => s.git(["cat-file", "-e", `${run.keptBranch}:extra.txt`]));

        // Losers are snapshotted before removal (§4.1 step 6): refs exist for 2 and 3.
        for (const n of [2, 3]) {
          const ref = `refs/opensand/missions/m-test/attempts/${n}`;
          const tree = (await s.git(["rev-parse", `${ref}^{tree}`])).trim();
          assert.match(tree, /^[0-9a-f]{40}$/);
        }
      } finally {
        await stub.close();
        await s.cleanup();
      }
    },
  );

  it("a mission budget stops the second attempt before its model call (§9 row 9)", { timeout: 60_000 }, async () => {
    const s = await setup();
    const stub = new StubProvider({
      "stub:a": [chatResponse(writesContent({ "README.md": "good\n" }), { promptTokens: 100, completionTokens: 1200 })],
    });
    const baseUrl = await stub.start();
    try {
      const run = await startTournament(
        baseOptions(s, {
          attempts: 2,
          concurrency: 1,
          missionBudgetUsd: 0.1,
          provider: openAiCompatProvider(baseUrl),
          limits: { maxTokensPerCall: 1000, infraBackoffMs: [5, 5, 5] },
        }),
      );
      // Attempt 1 settles $0.061 (100 in × $10/MTok + 1200 out × $50/MTok). Attempt 2's
      // reservation (1000 × $50/MTok = $0.05) would take the mission past
      // $0.10, so it stops before any call.
      assert.equal(run.winner, 1);
      assert.ok(Math.abs(run.attempts[0]!.result.costUsd! - 0.061) < 1e-9);
      assert.equal(run.attempts[1]!.result.outcome, "budget_stopped");
      assert.equal(stub.requests.length, 1);
      assert.equal(stub.requests[0]!.model, "stub:a");
      assert.ok(Math.abs(run.totalCostUsd - 0.061) < 1e-9);
    } finally {
      await stub.close();
      await s.cleanup();
    }
  });

  it("HTTP 402 parks the attempt on the same rung with no call to the next rung (§6.1)", { timeout: 60_000 }, async () => {
    const s = await setup();
    const stub = new StubProvider({ "stub:a": [{ status: 402, body: {} }] });
    const baseUrl = await stub.start();
    try {
      const run = await startTournament(
        baseOptions(s, { attempts: 1, concurrency: 1, provider: openAiCompatProvider(baseUrl) }),
      );
      assert.equal(run.status, "failed"); // no eligible attempt
      assert.equal(run.winner, null);
      const results = meshResults(await readMissionEvents(s));
      assert.equal(results[0]!.data.outcome, "infra_error");
      assert.equal(results[0]!.data.model, "stub:a");
      assert.equal(results[0]!.data.rung, 0);
      assert.equal(results[0]!.data.escalatedFrom, undefined);
      assert.equal(stub.requests.length, 1);
      assert.equal(await dirCount(s.attemptsRoot), 0);
      assert.equal((await worktreePaths(s.git)).length, 1);
    } finally {
      await stub.close();
      await s.cleanup();
    }
  });

  it("429 twice then 200 retries the same rung and passes (§9 row 7)", { timeout: 60_000 }, async () => {
    const s = await setup();
    const stub = new StubProvider({
      "stub:a": [
        { status: 429, body: {} },
        { status: 429, body: {} },
        chatResponse(writesContent({ "README.md": "good\n" }), { promptTokens: 100, completionTokens: 200 }),
      ],
    });
    const baseUrl = await stub.start();
    try {
      const run = await startTournament(
        baseOptions(s, {
          attempts: 1,
          concurrency: 1,
          provider: openAiCompatProvider(baseUrl),
          limits: { infraBackoffMs: [5, 5, 5] },
        }),
      );
      assert.equal(run.winner, 1);
      const r1 = meshResults(await readMissionEvents(s))[0]!.data;
      assert.equal(r1.outcome, "passed");
      assert.equal(r1.model, "stub:a");
      assert.equal(r1.rung, 0);
      assert.equal(stub.requests.length, 3);
      const rungs = (await readMissionEvents(s))
        .filter((e) => e.kind === "model.call")
        .map((e) => e.data.rung);
      assert.deepEqual(rungs, [0, 0, 0]);
    } finally {
      await stub.close();
      await s.cleanup();
    }
  });

  it("escalation stops at the §6.1 cap: two rungs up, never three", { timeout: 60_000 }, async () => {
    const s = await setup();
    const ladder = ["stub:a", "stub:b", "stub:c", "stub:d"];
    const stub = new StubProvider(
      Object.fromEntries(
        ladder.map((m) => [m, [chatResponse(writesContent({ [`${m}.txt`]: "x\n" }), { promptTokens: 10, completionTokens: 20 })]]),
      ),
    );
    const baseUrl = await stub.start();
    try {
      const run = await startTournament(
        baseOptions(s, {
          routes: routesFor(ladder),
          catalog: catalogFor(ladder),
          checkCommand: "false",
          attempts: 1,
          concurrency: 1,
          provider: openAiCompatProvider(baseUrl),
          limits: { infraBackoffMs: [5, 5, 5] },
        }),
      );
      assert.equal(run.status, "failed");
      const r1 = meshResults(await readMissionEvents(s))[0]!.data;
      assert.equal(r1.outcome, "check_failed");
      assert.equal(r1.model, "stub:c");
      assert.equal(r1.rung, 2);
      assert.equal(stub.requests.filter((r) => r.model === "stub:d").length, 0);
      assert.deepEqual(
        (await readMissionEvents(s)).filter((e) => e.kind === "model.call").map((e) => e.data.model),
        ["stub:a", "stub:b", "stub:c"],
      );
    } finally {
      await stub.close();
      await s.cleanup();
    }
  });

  it("refuses to start when a ladder model has no price, naming the model (§9 row 10)", async () => {
    const s = await setup();
    try {
      const catalog = catalogFor(["stub:a"]); // stub:b missing
      await assert.rejects(
        () =>
          startTournament(
            baseOptions(s, { catalog, provider: { call: async () => ({ ok: true, content: "" }) } }),
          ),
        /no price in the model catalog for stub:b/,
      );
      assert.equal(await dirCount(s.missionDir), 0);
    } finally {
      await s.cleanup();
    }
  });

  it("refuses to start when the mission log's hash chain is invalid (§6.1)", async () => {
    const s = await setup();
    try {
      await fs.mkdir(s.missionDir, { recursive: true });
      const broken = {
        seq: 1,
        ts: new Date().toISOString(),
        sessionId: s.missionId,
        kind: "mission.started",
        data: {},
        prev: "sha256:deadbeef",
      };
      await fs.writeFile(s.missionLogPath, JSON.stringify(broken) + "\n", "utf8");
      await assert.rejects(
        () => startTournament(baseOptions(s, { provider: { call: async () => ({ ok: true, content: "" }) } })),
        /hash chain is invalid/,
      );
      // The log was not touched by the refused start.
      const raw = await fs.readFile(s.missionLogPath, "utf8");
      assert.equal(raw.split("\n").filter(Boolean).length, 1);
    } finally {
      await s.cleanup();
    }
  });

  it("refuses to start when no sandbox exists on the host (§7)", async () => {
    const s = await setup();
    try {
      await assert.rejects(
        () =>
          startTournament(
            baseOptions(s, {
              sandboxLauncher: { kind: "unavailable", reason: "test: no sandbox" },
              provider: { call: async () => ({ ok: true, content: "" }) },
            }),
          ),
        /no sandbox on this host/,
      );
    } finally {
      await s.cleanup();
    }
  });

  it("limits refuse values over the §6.1 hard caps", () => {
    assert.throws(() => resolveTournamentLimits({ attempts: 6 }), /attempts.*hard cap 5/);
    assert.throws(() => resolveTournamentLimits({ concurrency: 4 }), /concurrency.*hard cap 3/);
    assert.throws(() => resolveTournamentLimits({ perAttemptWallClockMs: 61 * 60_000 }), /hard cap/);
    assert.throws(() => resolveTournamentLimits({ maxDiffLines: 1001 }), /hard cap/);
    assert.equal(resolveTournamentLimits({ attempts: 5, concurrency: 3 }).attempts, 5);
  });

  it("mesh.decision is write-once: a second settle with the same inputs appends nothing (§5.3)", async () => {
    const s = await setup();
    try {
      const decision: MeshDecision = {
        inputsHash: "h-1",
        eligible: [1],
        rejected: [],
        band: [1],
        order: [1],
        winner: 1,
        tieBreak: "deterministic",
      };
      const first = await settleMeshDecision(s.missionLogPath, decision);
      const second = await settleMeshDecision(s.missionLogPath, decision);
      assert.equal(first.appended, true);
      assert.equal(second.appended, false);
      assert.deepEqual(second.decision, decision);
      const events = await readMissionEvents(s);
      assert.equal(events.filter((e) => e.kind === "mesh.decision").length, 1);
    } finally {
      await s.cleanup();
    }
  });

  it("kill -9 mid-attempt, then reconcile, reaches the interrupted end state (§4.3, §6.2)", { timeout: 120_000 }, async () => {
    const s = await setup("m-kill");
    const stub = new StubProvider({ "stub:a": [{ status: 200, hang: true }] });
    const baseUrl = await stub.start();
    const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const distDir = path.join(engineDir, "dist");
    const childCode = `
      const { startTournament, openAiCompatProvider } = await import(${JSON.stringify(path.join(distDir, "src", "mesh", "tournament.js"))});
      const { parseRoutesConfig } = await import(${JSON.stringify(path.join(distDir, "src", "mesh", "routes-schema.js"))});
      const run = startTournament({
        missionId: ${JSON.stringify(s.missionId)},
        repoRoot: ${JSON.stringify(s.repoRoot)},
        stateDir: ${JSON.stringify(s.stateDir)},
        task: "t",
        role: "coder",
        routes: parseRoutesConfig({ version: 1, roles: { coder: { ladder: ["stub:a"], minSamples: 5, minPassRate: 0.5 } } }),
        stats: new Map(),
        catalog: { "stub:a": { family: "fam", priceInUsdPerMTok: 10, priceOutUsdPerMTok: 50 } },
        checkCommand: "true",
        provider: openAiCompatProvider(${JSON.stringify(baseUrl)}),
        sandboxLauncher: ${JSON.stringify(TEST_LAUNCHER)},
        checkSandbox: undefined,
        attempts: 1,
        concurrency: 1,
        limits: { perAttemptWallClockMs: 60000, infraBackoffMs: [5, 5, 5] },
      });
      run.then(() => process.exit(0), () => process.exit(1));
    `;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
        cwd: engineDir,
        stdio: "ignore",
      });

      // Wait until the child is mid-attempt (attempt.running logged), then kill it.
      const aLogPath = path.join(s.missionDir, "attempts-log.jsonl");
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error("child exited before reaching mid-attempt");
        const raw = await fs.readFile(aLogPath, "utf8").catch(() => "");
        if (raw.includes("attempt.running")) break;
        if (Date.now() > deadline) throw new Error("child never reached mid-attempt");
        await new Promise((r) => setTimeout(r, 50));
      }
      const killed = child.kill("SIGKILL");
      assert.equal(killed, true);
      await new Promise<void>((resolve) => child!.on("exit", () => resolve()));

      // Reconcile reaches the interrupted end state: nothing under the attempts
      // root, only main in the worktree list, the snapshot ref, and a
      // mesh.attempt.result recorded as interrupted.
      const report = await reconcileTournament({ missionId: s.missionId, repoRoot: s.repoRoot, stateDir: s.stateDir });
      assert.equal(await dirCount(s.attemptsRoot), 0);
      assert.equal((await worktreePaths(s.git)).length, 1);
      const ref = `refs/opensand/missions/m-kill/attempts/1`;
      await s.git(["rev-parse", `${ref}^{tree}`]);
      const results = meshResults(await readMissionEvents(s));
      assert.equal(results.length, 1);
      assert.equal(results[0]!.data.outcome, "interrupted");

      // A second reconcile is a no-op (idempotent, §4.3).
      const again = await reconcileTournament({ missionId: s.missionId, repoRoot: s.repoRoot, stateDir: s.stateDir });
      assert.deepEqual(again, []);
      assert.equal(meshResults(await readMissionEvents(s)).length, 1);
    } finally {
      child?.kill("SIGKILL");
      await stub.close();
      await s.cleanup();
    }
  });

  it("containment: a sandboxed command cannot write outside its attempt tree (§7)", { timeout: 60_000, skip: SKIPPED }, async () => {
    const s = await setup();
    try {
      const worktrees = new AttemptWorktrees({
        repoRoot: s.repoRoot,
        attemptsRoot: s.attemptsRoot,
        missionId: s.missionId,
        baseCommit: s.baseCommit,
        logPath: path.join(s.missionDir, "attempts-log.jsonl"),
      });
      await worktrees.reserve(1);
      await worktrees.create(1);
      const tree = worktrees.attemptPath(1);
      // Outside every allowlisted write root: the temp roots are allowlisted,
      // so the probe must target the home directory instead.
      const evil = evilPath();

      const build = buildSandboxedSpawn({
        command: `echo evil > ${JSON.stringify(evil)}`,
        cwd: tree,
        sandboxProfile: "workspace-write",
        workspaceRoot: tree,
      });
      const probe = await new Promise<{ code: number | null }>((resolve) => {
        const p = spawn(build.command, build.args, { cwd: tree, stdio: "ignore" });
        p.on("exit", (code) => resolve({ code }));
        p.on("error", () => resolve({ code: -1 }));
      });
      assert.notEqual(probe.code, 0, "the sandboxed write outside the tree must be denied");
      await assert.rejects(() => fs.access(evil), /ENOENT/);

      // Control: the same sandbox allows a write inside the tree.
      const inside = path.join(tree, "allowed.txt");
      const ok = buildSandboxedSpawn({
        command: `echo ok > ${JSON.stringify(inside)}`,
        cwd: tree,
        sandboxProfile: "workspace-write",
        workspaceRoot: tree,
      });
      const control = await new Promise<{ code: number | null }>((resolve) => {
        const p = spawn(ok.command, ok.args, { cwd: tree, stdio: "ignore" });
        p.on("exit", (code) => resolve({ code }));
        p.on("error", () => resolve({ code: -1 }));
      });
      assert.equal(control.code, 0);
      assert.equal(await fs.readFile(inside, "utf8"), "ok\n");

      await worktrees.snapshot(1);
      await worktrees.remove(1);
    } finally {
      await fs.rm(evilPath(), { force: true }).catch(() => {});
      await s.cleanup();
    }
  });
});

/** The probe target, outside every sandbox allowlist; a fixed name so cleanup is exact. */
function evilPath(): string {
  return path.join(os.homedir(), ".opensand-containment-probe");
}
