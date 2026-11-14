import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FolderTrustStore } from "@opensand/shared";

/**
 * Folder trust at CLI startup: `-y` must never answer the trust question, and a stored
 * `trusted` level must be honoured without asking. Hermetic: temp HOME, temp workspace.
 */

const CLI_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.js");

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p4e2-cli-trust-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { tmp, home, project: fs.realpathSync.native(project) };
}

function runCli(home: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf-8",
    input: "",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENSAND_STATE_DIR: path.join(home, ".opensand"),
      OPENSAND_API_KEY: "none",
    },
  });
}

test("CLI -y in an unanswered folder runs read-only and persists nothing", () => {
  const { tmp, home, project } = setup();
  try {
    const result = runCli(home, project, ["-y"]);
    const out = result.stderr + result.stdout;
    assert.match(out, /is not trusted: running read-only/, `output: ${out}`);
    assert.strictEqual(
      fs.existsSync(path.join(home, ".opensand", "folder-trust.json")),
      false,
      "-y must not write a trust record"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI without a terminal in an unanswered folder is read-only too", () => {
  const { tmp, home, project } = setup();
  try {
    const out = (() => {
      const r = runCli(home, project, []);
      return r.stderr + r.stdout;
    })();
    assert.match(out, /is not trusted: running read-only/, `output: ${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI with a stored trusted level does not warn or ask", async () => {
  const { tmp, home, project } = setup();
  try {
    const store = new FolderTrustStore({ baseDir: path.join(home, ".opensand") });
    await store.setLevel(project, "trusted");
    const result = runCli(home, project, ["-y"]);
    const out = result.stderr + result.stdout;
    assert.doesNotMatch(out, /not trusted/, `output: ${out}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
