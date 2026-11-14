import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../../scripts/pre-commit.sh", import.meta.url));

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-hook-")));
  const run = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
  run(["init", "-q"]);
  return { dir, run };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function runHook(dir: string, testCmd: string) {
  const env = cleanEnv();
  // What git exports to a hook:
  env.GIT_DIR = path.join(dir, ".git");
  env.GIT_INDEX_FILE = path.join(dir, ".git", "index");
  env.GIT_PREFIX = "";
  env.OPENSAND_PRECOMMIT_BUILD_CMD = "true";
  env.OPENSAND_PRECOMMIT_TEST_CMD = testCmd;
  return spawnSync("bash", [script], { cwd: dir, encoding: "utf8", env });
}

test("pre-commit: the test step sees no GIT_* hook variables", () => {
  const { dir } = setup();
  try {
    const out = path.join(dir, "seen-env.txt");
    const r = runHook(dir, `env | grep '^GIT_' > '${out}' || true`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.readFileSync(out, "utf8"), "", "GIT_* leaked into the test step");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-commit: tripwire fails the commit when the tests change local git config", () => {
  const { dir, run } = setup();
  try {
    const r = runHook(dir, "git config --local core.bare true");
    assert.notEqual(r.status, 0, "tripwire did not fire");
    assert.match(r.stderr, /TRIPWIRE/);
    assert.match(r.stderr, /core\.bare=true/);
    assert.equal(run(["config", "--local", "--get", "core.bare"]).stdout.trim(), "true");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-commit: tripwire fails the commit when the tests change refs/opensand", () => {
  const { dir, run } = setup();
  try {
    run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
    const r = runHook(dir, "git update-ref refs/opensand/stray HEAD");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refs\/opensand/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
