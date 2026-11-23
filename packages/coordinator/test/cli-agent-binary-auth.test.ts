import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapCliBinaryAuth } from "../src/providers/runtime/cli-agent-binary-auth.js";
import { credentialHome, type DeviceAuthSpec } from "../src/providers/runtime/device-auth.js";

const provider = "cli-auth-test";
const homeEnv = "CLI_AUTH_TEST_HOME";
const homeDir = ".cli-auth-test";
const signedInFile = "auth.json";
const secret = "fake-secret-DO-NOT-PRINT-9f3a";

const spec: DeviceAuthSpec = {
  provider,
  homeEnv,
  homeDir,
  signedInFile,
  loginArgs: [],
  urlPattern: /(?!)/,
  codePattern: /(?!)/,
  failureMessage: "test",
};

describe("CLI binary auth wrapper", () => {
  let tmpDir: string;
  let savedHome: string | undefined;

  before(() => {
    savedHome = process.env.HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-cli-auth-"));
    process.env.HOME = tmpDir;
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCredentials(): string {
    const home = credentialHome(spec);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, signedInFile), secret);
    return home;
  }

  it("shares the credential home, detects sign-in, injects the home env and clears credentials", () => {
    const home = writeCredentials();
    const auth = wrapCliBinaryAuth(spec);
    assert.equal(auth.home, home);
    assert.equal(auth.isSignedIn(), true);
    assert.equal(auth.env(process.env as Record<string, string>)[homeEnv], home);
    assert.equal(auth.env()[homeEnv], home);

    auth.clear();
    assert.equal(fs.existsSync(path.join(home, signedInFile)), false);
    assert.equal(auth.isSignedIn(), false);
  });

  it("script prints only provider/home/signedIn and never the credential value", () => {
    const home = writeCredentials();
    const script = fileURLToPath(new URL("../../../../scripts/cli-agent-auth.mjs", import.meta.url));
    const args = ["--provider", provider, "--home-env", homeEnv, "--home-dir", homeDir, "--signed-in-file", signedInFile];
    const env = { ...process.env, HOME: tmpDir };

    const status = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(status.stdout), { provider, home, signedIn: true });
    assert.ok(!status.stdout.includes(secret));

    const clear = spawnSync(process.execPath, [script, ...args, "--action", "clear"], { encoding: "utf8", env });
    assert.equal(clear.status, 0, clear.stderr);
    assert.deepEqual(JSON.parse(clear.stdout), { provider, home, signedIn: false });
    assert.ok(!clear.stdout.includes(secret));
    assert.equal(fs.existsSync(path.join(home, signedInFile)), false);
  });
});
