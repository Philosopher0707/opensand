import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommandOperation } from "../src/command-runner.js";

describe("CommandRunner", () => {
  it("executes a standard bash command successfully", async () => {
    const res = await runCommandOperation({
      command: "echo 'hello from opensand'",
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout.trim(), "hello from opensand");
    assert.equal(res.stderr, "");
    assert.ok(res.durationMs >= 0);
  });

  it("captures non-zero exit code and stderr", async () => {
    const res = await runCommandOperation({
      command: "bash -c 'echo \"error trace\" >&2; exit 42'",
    });

    assert.equal(res.exitCode, 42);
    assert.equal(res.stderr.trim(), "error trace");
  });

  it("enforces timeout on long-running commands", async () => {
    const res = await runCommandOperation({
      command: "sleep 10",
      timeout_ms: 500,
    });

    assert.equal(res.signal, "SIGTERM");
    assert.match(res.stderr, /Command timed out/);
  });

  it("rejects dangerous bash commands before execution", async () => {
    await assert.rejects(
      async () => {
        await runCommandOperation({ command: "rm -rf /" });
      },
      /Dangerous command blocked by safety gate/
    );
  });

  it("rejects invalid bash syntax before execution", async () => {
    await assert.rejects(
      async () => {
        await runCommandOperation({ command: "echo 'unclosed" });
      },
      /Bash syntax error/
    );
  });
});
