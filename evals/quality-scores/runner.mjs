#!/usr/bin/env node
// Quality-scores harness. All verdicts come from runCheck() over a fresh check
// copy; the agent's final text is only an untrusted claim, never evidence.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TASKS_DIR = path.join(ROOT, "evals/quality-scores/tasks");
export const RUNS_DIR = path.join(ROOT, "evals/quality-scores/runs");
export const CONFIG_PATH = path.join(ROOT, "evals/quality-scores/engines.json");
export const CHECK_FILE = "hidden.test.mjs";
export const CHECK_COMMAND = "node --test hidden.test.mjs";
export const ALL_TASKS = [
  "sum", "fizzbuzz", "is-prime", "roman", "csv-line", "deep-get",
  "group-by", "slugify", "word-count", "merge-sorted", "parse-duration", "balance",
];
export const CLAIM_RE = /\b(done|complete[sd]?|implemented|tests?\s+pass(?:ed|ing)?|fixed)\b/i;
const MAX_CLAIM = 1000;
const MAX_CHECK_OUTPUT = 4 * 1024;

export class ConfigError extends Error {}
export class ControlError extends Error {}

/** Credentials never reach a child unless the caller explicitly allows them (a :free model). */
const CREDENTIAL_RE = /(_API_KEY|_ACCESS_TOKEN|_TOKEN|_SECRET|_PASSWORD|^GH_TOKEN$|^NPM_TOKEN$)/i;
export function isolatedEnv(allow = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_RE.test(key) && !allow.includes(key)) delete env[key];
  }
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}
export function scrubProcessEnv(allow = []) {
  for (const key of Object.keys(process.env)) {
    if ((CREDENTIAL_RE.test(key) && !allow.includes(key)) || key.startsWith("GIT_")) delete process.env[key];
  }
}

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv() });
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function hashFile(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file, "utf8")) : null;
}

export function hasClaim(text) {
  return CLAIM_RE.test(String(text ?? "").slice(0, 10_000));
}
/** Untrusted agent text becomes bounded, single-line, non-markdown, non-tag data. */
export function sanitizeClaim(text) {
  let out = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  out = out.replace(/\r/g, "").replace(/[\t\n]+/g, " ").trim();
  out = out.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
  out = out.replace(/([`*_])/g, "\\$1");
  return out.length > MAX_CLAIM ? `${out.slice(0, MAX_CLAIM - 3)}...` : out;
}

export function loadFixture(id) {
  const file = path.join(TASKS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new ConfigError(`missing task fixture: ${file}`);
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  if (fixture.id !== id) throw new ConfigError(`fixture id mismatch in ${file}`);
  return fixture;
}
export function loadConfig(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) throw new ConfigError(`missing engine config: ${file}`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!config || typeof config !== "object" || !config.engines) throw new ConfigError("engines.json has no engines");
  return config;
}

export function validateFixture(fixture) {
  assert.equal(typeof fixture.prompt, "string", "prompt must be a string");
  assert.equal(fixture.checkCommand, CHECK_COMMAND, "checkCommand must be the fixed node --test command");
  assert.ok(fixture.seed && typeof fixture.seed === "object", "seed must be an object");
  assert.ok(fixture.seed["solution.mjs"]?.includes("not implemented"), "seed stub must throw not implemented");
  assert.ok(fixture.seed["package.json"]?.includes('"type":"module"'), "seed package.json must be ESM");
  assert.ok(fixture.solution && fixture.solution["solution.mjs"], "fixture needs a reference solution");
  assert.match(fixture.check, /from "node:test"/, "check must use node:test");
  assert.match(fixture.check, /node:assert/, "check must use node:assert");
  assert.match(fixture.check, /\.\/solution\.mjs/, "check must import solution.mjs");
  for (const record of [fixture.seed, fixture.solution]) {
    for (const rel of Object.keys(record)) assertSafeRel(rel);
  }
  return true;
}
function assertSafeRel(rel) {
  assert.ok(typeof rel === "string" && rel.length > 0 && !path.isAbsolute(rel), "unsafe file path");
  assert.ok(!rel.split(/[\\/]/).includes(".."), "unsafe file path");
}

export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    assertSafeRel(rel);
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

/** One fresh, self-contained git repo per task; no owner files, no shared cache. */
export function createWorkspace(stage, id, seed) {
  const dir = fs.mkdtempSync(path.join(stage, `workspace-${id}-`));
  writeFiles(dir, seed);
  git(["init", "-q"], dir);
  git(["config", "user.email", "quality-scores@opensand.local"], dir);
  git(["config", "user.name", "OpenSand Quality Scores"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "--no-gpg-sign", "-m", "base"], dir);
  return dir;
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyTree(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
    // Symlinks and special files are deliberately not copied.
  }
}

/**
 * The check copy is built AFTER the turn. Agent-written hidden.test.mjs is
 * dropped and the harness bytes are written in its place, so no turn can edit,
 * delete or time-bomb the test by writing into its own workspace.
 */
export function createCheckCopy(stage, id, workspace, checkSource) {
  const dir = fs.mkdtempSync(path.join(stage, `check-${id}-`));
  copyTree(workspace, dir);
  fs.rmSync(path.join(dir, CHECK_FILE), { force: true });
  fs.writeFileSync(path.join(dir, CHECK_FILE), checkSource, "utf8");
  return { dir, harnessHash: sha256(checkSource), workspaceHash: hashFile(path.join(workspace, CHECK_FILE)) };
}

function parseCheckCommand(command) {
  assert.equal(command, CHECK_COMMAND, `unsupported check command: ${command}`);
  return [process.execPath, "--test", CHECK_FILE];
}

async function execInput(input, timeoutMs, opts = {}) {
  const argv = parseCheckCommand(input.command);
  const started = Date.now();
  const common = {
    cwd: input.cwd ?? input.workspaceRoot,
    env: isolatedEnv(),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), common);
    return { exitCode: 0, signal: null, durationMs: Date.now() - started, stdout, stderr };
  } catch (err) {
    return {
      exitCode: Number.isInteger(err.code) ? err.code : 1,
      signal: err.signal ?? null,
      durationMs: Date.now() - started,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (err.message ?? ""),
    };
  }
}

/** Hermetic mirror of runCheck's verdict rule, so selftest needs no build. */
export async function localCheckExecutor(command, cwd, timeoutMs) {
  const r = await execInput({ command, cwd }, timeoutMs);
  return {
    exitCode: r.exitCode,
    signal: r.signal,
    durationMs: r.durationMs,
    outputTail: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-MAX_CHECK_OUTPUT),
    passed: r.exitCode === 0 && r.signal === null,
  };
}

/** Real runs: the verdict rule is runCheck's, never ours and never the claim's. */
export async function harnessCheckExecutor(command, cwd, timeoutMs) {
  const { runCheck } = await import(pathToFileURL(path.join(ROOT, "packages/engine/dist/src/missions/check.js")).href);
  return runCheck(
    { command, timeoutMs },
    cwd,
    { exec: (input, opts) => execInput({ ...input, cwd }, timeoutMs, opts) },
  );
}

function diffLines(workspace) {
  try {
    git(["add", "-A"], workspace);
    const out = git(["diff", "--cached", "--numstat", "HEAD"], workspace);
    return out.split("\n").reduce((sum, line) => {
      const [a, b] = line.split("\t");
      return sum + (/^\d+$/.test(a) ? Number(a) : 0) + (/^\d+$/.test(b) ? Number(b) : 0);
    }, 0);
  } catch {
    return 0;
  }
}

export async function evaluateTask({ fixture, stage, turn, checkExecutor = harnessCheckExecutor, timeoutMs = 60_000 }) {
  validateFixture(fixture);
  const started = Date.now();
  const workspace = createWorkspace(stage, fixture.id, fixture.seed);
  let checkCopy = null;
  try {
    const rawClaim = await turn(fixture.prompt, workspace);
    checkCopy = createCheckCopy(stage, fixture.id, workspace, fixture.check);
    const beforeHash = hashFile(path.join(checkCopy.dir, CHECK_FILE));
    const check = await checkExecutor(fixture.checkCommand, checkCopy.dir, timeoutMs);
    const afterHash = hashFile(path.join(checkCopy.dir, CHECK_FILE));
    const tamper = checkCopy.workspaceHash !== null || beforeHash !== checkCopy.harnessHash || afterHash !== checkCopy.harnessHash;
    let verdict = check.passed ? "verified" : "failed";
    if (tamper && verdict === "verified") verdict = "failed"; // fail closed
    return {
      id: fixture.id,
      verdict,
      claim: sanitizeClaim(rawClaim),
      checkExitCode: check.exitCode,
      falseDone: hasClaim(rawClaim) && verdict !== "verified",
      tamper,
      durationMs: Date.now() - started,
      diffLines: diffLines(workspace),
      checkHash: checkCopy.harnessHash,
    };
  } finally {
    if (checkCopy) fs.rmSync(checkCopy.dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
const OPENROUTER = "https://openrouter.ai/api/v1";

export async function preflight({ engine, model, baseUrl, config = loadConfig() }) {
  const entry = config.engines?.[engine];
  if (!entry) throw new ConfigError(`unknown --engine '${engine}' (allowed: ${Object.keys(config.engines ?? {}).join(", ")})`);
  if (entry.kind === "external" && !engine.startsWith("external:")) {
    throw new ConfigError(`engine '${engine}' must be selected as --engine external:${engine}`);
  }
  const url = (baseUrl ?? entry.baseUrl ?? "").replace(/\/+$/, "");
  const loopback = isLoopback(url);
  if (!loopback && url !== OPENROUTER) {
    throw new ConfigError(`refusing endpoint '${url}': only loopback or ${OPENROUTER} are accepted`);
  }
  if (!model) throw new ConfigError("a --model id is required");
  if (!loopback && !model.endsWith(":free")) {
    throw new ConfigError(`refusing paid model '${model}' on '${url}': only :free model ids are accepted`);
  }
  if (!loopback && !process.env.OPENROUTER_API_KEY) {
    throw new ConfigError(`${url} with ${model} needs your OPENROUTER_API_KEY; no key was found`);
  }
  let listed = [];
  try {
    const response = await fetch(`${url}/models`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    listed = (body.data ?? []).map((m) => m.id);
  } catch (err) {
    throw new ConfigError(`cannot list models at ${url}: ${err.message}`);
  }
  if (!listed.includes(model)) {
    throw new ConfigError(`model '${model}' is not listed at ${url}`);
  }
  const effective = { engine, model, baseUrl: url, free: model.endsWith(":free") };
  return { ...effective, configHash: sha256(JSON.stringify(effective)), availableModels: listed.length };
}

export function renderMarkdown(run) {
  const rows = run.tasks.map((t) =>
    `| ${t.id} | ${t.verdict} | ${t.falseDone ? "yes" : "no"} | ${t.tamper ? "yes" : "no"} | ${t.checkExitCode ?? "null"} | ${t.durationMs} | ${t.claim || "(no claim)"} |`,
  );
  return [
    `# Quality scores — ${run.runId}`,
    "",
    `Engine: ${run.effectiveConfig.engine} · model: ${run.effectiveConfig.model} · config hash: \`${run.effectiveConfig.configHash}\``,
    "",
    `Control: **${run.control.verdict}**`,
    "",
    "| Task | Verdict | False done | Tamper | Check exit | ms | Claim |",
    "| :--- | :--- | :--- | :--- | :--- | --- | :--- |",
    ...rows,
    "",
    `**${run.aggregates.completed}/${run.aggregates.total} completed · completion_rate=${run.aggregates.completion_rate} · false_done=${run.aggregates.false_done} · false_done_rate=${run.aggregates.false_done_rate} · tamper=${run.aggregates.tamper}**`,
    "",
  ].join("\n");
}

export function writeRun(outDir, run) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${run.runId}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const mdPath = path.join(outDir, `${run.runId}.md`);
  fs.writeFileSync(mdPath, renderMarkdown(run), "utf8");
  return { jsonPath, mdPath };
}

export async function runSuite({
  engine = "native",
  model,
  baseUrl,
  tasks = ALL_TASKS,
  turnFor,
  checkExecutor = harnessCheckExecutor,
  outDir = RUNS_DIR,
  effective,
  controlOnly = false,
  timeoutMs = 60_000,
}) {
  for (const id of tasks) if (!ALL_TASKS.includes(id)) throw new ConfigError(`unknown task '${id}'`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-quality-scores-"));
  try {
    // Control first: a broken harness must not print a zero score as a model result.
    const controlFixture = loadFixture("sum");
    const control = await evaluateTask({
      fixture: controlFixture,
      stage,
      turn: scriptedControlTurn(),
      checkExecutor,
      timeoutMs,
    });
    if (control.verdict !== "verified") throw new ControlError(`control task failed: ${JSON.stringify(control)}`);
    if (controlOnly) return { control, tasks: [], aggregates: { total: 0, completed: 0, completion_rate: 0, false_done: 0, false_done_rate: 0, tamper: 0 } };

    const results = [];
    for (const id of tasks) {
      const fixture = loadFixture(id);
      const result = await evaluateTask({ fixture, stage, turn: await turnFor(fixture), checkExecutor, timeoutMs });
      results.push(result);
      console.log(`==> ${id}: ${result.verdict} (exit ${result.checkExitCode ?? "null"}, ${result.durationMs} ms)${result.falseDone ? " false_done" : ""}${result.tamper ? " tamper" : ""}`);
    }
    const claimed = results.filter((r) => r.claim && hasClaim(r.claim));
    const completed = results.filter((r) => r.verdict === "verified").length;
    const falseDone = results.filter((r) => r.falseDone).length;
    const aggregates = {
      total: results.length,
      completed,
      completion_rate: results.length ? Number((completed / results.length).toFixed(4)) : 0,
      false_done: falseDone,
      false_done_rate: claimed.length ? Number((falseDone / claimed.length).toFixed(4)) : 0,
      tamper: results.filter((r) => r.tamper).length,
    };
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${engine.replace(/[^a-z0-9]/gi, "_")}`;
    const run = {
      schemaVersion: 1,
      runId,
      effectiveConfig: effective ?? { engine, model, baseUrl, configHash: "unverified" },
      control,
      tasks: results,
      aggregates,
    };
    const files = writeRun(outDir, run);
    console.log(`${completed}/${results.length} tasks scored, false_done=${falseDone}, tamper=${aggregates.tamper}`);
    console.log(`wrote ${files.jsonPath} and ${files.mdPath}`);
    return run;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true }); // cleanup even on failure
  }
}

/** A known-good patch for the control task (also used by the hermetic selftest). */
export function scriptedControlTurn() {
  return async (_prompt, workspaceRoot) => {
    writeFiles(workspaceRoot, loadFixture("sum").solution);
    return "control solved";
  };
}

function parseArgs(argv) {
  const args = { engine: "native", tasks: null, controlOnly: false, preflightOnly: false, outDir: RUNS_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--engine": args.engine = argv[++i]; break;
      case "--model": args.model = argv[++i]; break;
      case "--base-url": args.baseUrl = argv[++i]; break;
      case "--tasks": args.tasks = (argv[++i] ?? "").split(",").filter(Boolean); break;
      case "--out": args.outDir = argv[++i]; break;
      case "--control-only": args.controlOnly = true; break;
      case "--preflight": args.preflightOnly = true; break;
      case "--help":
        console.log("Usage: runner.mjs [--engine native|external:<id>] [--model <id>] [--base-url <url>] [--tasks <ids>] [--control-only] [--preflight]");
        process.exit(0);
        break;
      default: throw new ConfigError(`unknown argument '${a}'`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const entry = config.engines?.[args.engine];
  const model = args.model ?? entry?.model;
  const baseUrl = args.baseUrl ?? entry?.baseUrl;
  let effective;
  try {
    effective = await preflight({ engine: args.engine, model, baseUrl, config });
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(2);
  }
  if (args.preflightOnly) {
    console.log(JSON.stringify(effective));
    return;
  }
  const allow = model.endsWith(":free") ? ["OPENROUTER_API_KEY"] : [];
  scrubProcessEnv(allow);
  const { makeTurnProvider } = await import(pathToFileURL(path.join(ROOT, "evals/quality-scores/coding-agent.mjs")).href);
  const turnFor = async (fixture) => {
    const provider = await makeTurnProvider({ engine: args.engine, model, baseUrl, config, workspaceRootHint: fixture.id });
    return provider.turn;
  };
  try {
    await runSuite({
      engine: args.engine,
      model,
      baseUrl,
      tasks: args.tasks ?? ALL_TASKS,
      turnFor,
      outDir: args.outDir,
      effective,
      controlOnly: args.controlOnly,
    });
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(err instanceof ControlError ? 1 : 1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
}
