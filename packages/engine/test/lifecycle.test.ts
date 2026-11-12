import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { EngineProcess, binPath, removeDir, tempDir } from "./helpers.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { version: string };

describe("engine lifecycle over stdio", () => {
  it("answers ping and status, survives a malformed line, and shuts down with exit 0", async () => {
    const dir = tempDir("lifecycle");
    const engine = new EngineProcess(dir);
    try {
      const before = Date.now();
      const ping = await engine.request("req-1", "engine.Engine.ping");
      assert.equal(ping.error, undefined);
      const timestamp = (ping.result as { timestamp: string }).timestamp;
      assert.ok(Date.parse(timestamp) >= before - 1_000, `bad timestamp ${timestamp}`);

      const status = await engine.request("req-2", "engine.Engine.status");
      assert.deepEqual(Object.keys(status.result as object).sort(), [
        "activeMissions",
        "pid",
        "uptimeMs",
        "version",
      ]);
      const info = status.result as { version: string; pid: number; activeMissions: number; uptimeMs: number };
      assert.equal(info.version, pkg.version);
      assert.equal(info.pid, engine.child.pid);
      assert.equal(info.activeMissions, 0);
      assert.ok(info.uptimeMs >= 0);

      engine.child.stdin.write("{not json\n");
      const parseError = await engine.waitFor((frame) => frame.error?.code === -32700);
      assert.equal(parseError.error?.code, -32700);

      const stillAlive = await engine.request("req-3", "engine.Engine.ping");
      assert.equal(stillAlive.error, undefined);

      const started = Date.now();
      const shutdown = await engine.request("req-4", "engine.Engine.shutdown");
      assert.deepEqual(shutdown.result, { success: true });
      assert.equal(await engine.exited, 0);
      assert.ok(Date.now() - started < 2_000, "graceful shutdown took longer than 2 s");
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("force shutdown exits immediately", async () => {
    const dir = tempDir("force");
    const engine = new EngineProcess(dir);
    try {
      const started = Date.now();
      await engine.request("req-1", "engine.Engine.shutdown", { force: true });
      assert.equal(await engine.exited, 0);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("SIGTERM takes the graceful path and exits 0", async () => {
    const dir = tempDir("sigterm");
    const engine = new EngineProcess(dir);
    try {
      await engine.request("req-1", "engine.Engine.ping");
      engine.child.kill("SIGTERM");
      assert.equal(await engine.exited, 0);
    } finally {
      await engine.kill();
      removeDir(dir);
    }
  });

  it("exits 2 when --stdio is missing", async () => {
    const dir = tempDir("args");
    try {
      const result = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [binPath], {
          env: { ...process.env, HOME: `${dir}/home` },
          stdio: "ignore",
        });
        child.once("exit", (code) => resolve(code));
      });
      assert.equal(result, 2);
    } finally {
      removeDir(dir);
    }
  });
});
