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

  it("kills a running command when the turn is cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 150);

    const res = await runCommandOperation(
      { command: "sleep 10", timeout_ms: 60_000 },
      { signal: controller.signal }
    );

    assert.equal(res.aborted, true);
    assert.equal(res.signal, "SIGTERM");
    assert.match(res.stderr, /aborted by user/);
    assert.ok(Date.now() - started < 5_000, "abort must not wait for the timeout");
  });

  it("does not spawn when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await runCommandOperation({ command: "sleep 10" }, { signal: controller.signal });

    assert.equal(res.aborted, true);
    assert.equal(res.durationMs, 0);
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
