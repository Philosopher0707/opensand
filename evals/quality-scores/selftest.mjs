#!/usr/bin/env node
// Hermetic selftest for the quality-scores harness: no model, no account, no network
// beyond an in-process loopback /v1/models stub.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { scriptedTurn } from "./coding-agent.mjs";
import {
  ALL_TASKS, CHECK_FILE, ConfigError, createCheckCopy, createWorkspace, evaluateTask,
  hasClaim, loadFixture, loadConfig, localCheckExecutor, preflight,
  runSuite, sanitizeClaim, sha256, validateFixture,
} from "./runner.mjs";

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "qs-selftest-"));
const outDir = path.join(stage, "runs");
let passed = 0;
function ok(section) { passed++; console.log(`==> ${section}: ok`); }

try {
  // 1. Fixture shape and pre-fix failure (red) for all 12.
  const ids = fs.readdirSync(path.join(path.dirname(new URL(import.meta.url).pathname), "tasks"))
    .filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(ids, [...ALL_TASKS].sort(), "the 12 fixture ids match the catalog");
  for (const id of ids) {
    const fixture = loadFixture(id);
    assert.equal(validateFixture(fixture), true);
    const result = await evaluateTask({ fixture, stage, turn: scriptedTurn({}, ""), checkExecutor: localCheckExecutor });
    assert.equal(result.verdict, "failed", `${id} stub must fail its hidden check`);
    assert.equal(result.falseDone, false, `${id} stub with no claim is not false-done`);
  }
  ok(`[1/6] 12 fixtures validated and all 12 seed stubs fail their hidden check`);

  // 2. Reference solutions pass (green).
  for (const id of ids) {
    const fixture = loadFixture(id);
    const result = await evaluateTask({ fixture, stage, turn: scriptedTurn(fixture.solution, "done"), checkExecutor: localCheckExecutor });
    assert.equal(result.verdict, "verified", `${id} reference solution must pass`);
    assert.equal(result.checkExitCode, 0);
    assert.ok(result.diffLines > 0, `${id} records changed lines`);
  }
  ok("[2/6] all 12 reference solutions pass with harness verdict verified");

  // 3. Control verifies before any task is scored.
  const controlRun = await runSuite({
    tasks: ["sum"],
    turnFor: async () => scriptedTurn({}, ""),
    checkExecutor: localCheckExecutor,
    outDir,
    controlOnly: true,
    effective: { engine: "native", model: "stub", baseUrl: "loopback", configHash: "0".repeat(64) },
  });
  assert.equal(controlRun.control.verdict, "verified");
  assert.deepEqual(controlRun.tasks, []);
  ok("[3/6] control task verifies and control-only scores no tasks");

  // 4. Claim-only agent: false_done=1, completion_rate=0.
  const falseRun = await runSuite({
    tasks: ["sum", "balance", "roman"],
    turnFor: async () => scriptedTurn({}, "all tests pass"),
    checkExecutor: localCheckExecutor,
    outDir,
    effective: { engine: "native", model: "stub", baseUrl: "loopback", configHash: "a".repeat(64) },
  });
  assert.equal(falseRun.aggregates.completed, 0);
  assert.equal(falseRun.aggregates.completion_rate, 0);
  assert.equal(falseRun.aggregates.false_done, 3);
  assert.equal(falseRun.aggregates.false_done_rate, 1);
  assert.ok(falseRun.tasks.every((t) => t.verdict === "failed"));
  ok("[4/6] claim-only agent yields false_done=3, completion_rate=0");

  // 5. Tamper: agent-written hidden test and fake node shim cannot win.
  const fixture = loadFixture("sum");
  const tamperWrites = {
    "hidden.test.mjs": 'import test from "node:test"; test("fake", () => {});\n',
    "node": "#!/bin/sh\nexit 0\n",
  };
  const tampered = await evaluateTask({ fixture, stage, turn: scriptedTurn(tamperWrites, "done"), checkExecutor: localCheckExecutor });
  assert.equal(tampered.tamper, true, "an agent-written hidden.test.mjs is recorded as tamper");
  assert.equal(tampered.verdict, "failed", "tamper never turns into verified");
  const ws = createWorkspace(stage, "tamper", fixture.seed);
  fs.writeFileSync(path.join(ws, CHECK_FILE), "fake agent test\n", "utf8");
  const copied = createCheckCopy(stage, "tamper", ws, fixture.check);
  assert.notEqual(copied.workspaceHash, null, "the agent-written test is hashed as tamper evidence");
  assert.equal(sha256(fs.readFileSync(path.join(copied.dir, CHECK_FILE), "utf8")), copied.harnessHash, "harness bytes replace the agent's test");
  fs.rmSync(copied.dir, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  ok("[5/6] hidden-test tamper is detected and the verdict stays failed");

  // 6. Preflight refuses paid/unlisted targets before any task; schema and claim are bounded.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "stub-model:latest" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const good = await preflight({ engine: "native", model: "stub-model:latest", baseUrl, config: loadConfig() });
    assert.match(good.configHash, /^[0-9a-f]{64}$/);
    for (const bad of [
      { engine: "native", model: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
      { engine: "native", model: "missing-model", baseUrl },
      { engine: "bogus", model: "stub-model:latest", baseUrl },
    ]) {
      await assert.rejects(() => preflight({ ...bad, config: loadConfig() }), ConfigError, `refuse ${JSON.stringify(bad)}`);
    }
  } finally {
    server.close();
  }
  const dirty = "done | <script>alert(1)</script>\n`code` **bold** " + "x".repeat(2000);
  const clean = sanitizeClaim(dirty);
  assert.ok(clean.length <= 1000);
  assert.ok(!clean.includes("\n") && !clean.includes("<script>"));
  assert.ok(clean.includes("\\`"), "backticks are escaped so they cannot open code spans");
  assert.ok(clean.includes("\\|"));
  assert.equal(hasClaim(dirty), true);

  const schemaRun = await runSuite({
    tasks: ["sum"],
    turnFor: async () => scriptedTurn({}, "done | <b>x</b>"),
    checkExecutor: localCheckExecutor,
    outDir,
    effective: { engine: "native", model: "stub", baseUrl: "loopback", configHash: "b".repeat(64) },
  });
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json"));
  const jsonFile = files.find((f) => f.startsWith(schemaRun.runId));
  assert.ok(jsonFile, "a JSON run file was written");
  const saved = JSON.parse(fs.readFileSync(path.join(outDir, jsonFile), "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.match(saved.effectiveConfig.configHash, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(saved.tasks) && saved.tasks.length === 1);
  assert.ok("falseDone" in saved.tasks[0] && "tamper" in saved.tasks[0] && "checkHash" in saved.tasks[0]);
  const md = fs.readFileSync(path.join(outDir, `${schemaRun.runId}.md`), "utf8");
  assert.match(md, /\| Task \| Verdict \| False done \| Tamper \|/);
  assert.match(md, /completion_rate=/);
  assert.ok(!md.includes("<b>x</b>"), "markdown injection is escaped out of the report");
  ok("[6/6] paid/unlisted engines exit 2, config hash present, JSON+MD schema and claim sanitization hold");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

console.log(`quality-scores-selftest: ok (${passed} sections)`);
