import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * `--worktree` must fail fast: if the isolated worktree cannot be created the
 * CLI exits with code 1 instead of silently continuing in the shared folder.
 */

const CLI_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "bin.js"
);

test("CLI --worktree exits with code 1 when the worktree cannot be created", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-p4d-cli-worktree-"));
  const homeDir = path.join(tmpDir, "home");
  const notARepo = path.join(tmpDir, "not-a-repo");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(notARepo, { recursive: true });

  try {
    const result = spawnSync(process.execPath, [CLI_ENTRY, "--worktree", "p4d-failfast"], {
      cwd: notARepo,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        // Hermetic home: the CLI must not touch the real ~/.opensand.
        HOME: homeDir,
        USERPROFILE: homeDir,
        OPENSAND_API_KEY: "none",
      },
    });

    assert.strictEqual(result.status, 1, `expected exit code 1, stderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /Failed to create isolated Git worktree/,
      `expected the fail-fast error on stderr, stderr: ${result.stderr}`
    );
    assert.doesNotMatch(
      result.stderr + result.stdout,
      /Continuing in current workspace/,
      "the silent fallback must be gone"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
