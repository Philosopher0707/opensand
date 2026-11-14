import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PtySession } from "../src/pty-session.js";
import { PtySessionManager } from "../src/pty-manager.js";
import { ToolRegistry } from "../src/tool-registry.js";

describe("PtySession", () => {
  it("spawns a process, streams output, and reports clean snapshot on exit", async () => {
    const session = new PtySession({
      command: "echo \"hello pty session\"",
    });

    assert.ok(session.id);
    assert.ok(session.pid > 0 || session.pid === -1);
    assert.equal(session.running, true);

    const snapshot = await session.waitForExit(4000);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.exitCode, 0);
    assert.match(session.getOutput(), /hello pty session/);
    assert.ok(snapshot.durationMs >= 0);
  });

  it("handles interactive stdin writing and receives response", async () => {
    const session = new PtySession({
      command: "cat",
    });

    assert.equal(session.running, true);

    let received = "";
    session.on("data", (chunk: string) => {
      received += chunk;
    });

    await session.write("ping from interactive test\n");

    for (let i = 0; i < 50; i++) {
      if (received.includes("ping from interactive test")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.match(received, /ping from interactive test/);
    assert.match(session.getOutput(), /ping from interactive test/);

    await session.kill("SIGTERM");
    await session.waitForExit(2000);
    assert.equal(session.running, false);
  });

  it("emits data and exit events cleanly", async () => {
    const session = new PtySession({
      command: "node",
      args: ["-e", "console.log(\"event test\"); process.exit(0);"],
    });

    let dataEmitted = false;
    let exitEmitted = false;
    let exitCodeReported: number | null = null;

    session.on("data", (text: string) => {
      if (text.includes("event test")) {
        dataEmitted = true;
      }
    });

    session.on("exit", (code: number | null) => {
      exitEmitted = true;
      exitCodeReported = code;
    });

    await session.waitForExit(3000);

    assert.equal(dataEmitted, true);
    assert.equal(exitEmitted, true);
    assert.equal(exitCodeReported, 0);
  });

  it("terminates a long-running process using kill()", async () => {
    const session = new PtySession({
      command: "sleep",
      args: ["60"],
    });

    assert.equal(session.running, true);
    const killed = await session.kill("SIGTERM");
    assert.equal(killed, true);

    const snapshot = await session.waitForExit(3000);
    assert.equal(snapshot.running, false);
    assert.ok(snapshot.signal === "SIGTERM" || snapshot.exitCode !== 0);
  });

  it("enforces rolling 128KB buffer ceiling when output exceeds limit", async () => {
    // Generate ~150KB of output using node script
    const session = new PtySession({
      command: "node",
      args: ["-e", "for (let i = 0; i < 1500; i++) { console.log(\"LINE_\" + String(i).padStart(5, \"0\") + \"_\" + \"x\".repeat(95)); }"],
    });

    await session.waitForExit(5000);
    assert.equal(session.running, false);

    const output = session.getOutput();
    assert.ok(output.length <= session.maxBufferSize, `Output length ${output.length} should not exceed ${session.maxBufferSize}`);
    // Should contain the last lines produced (e.g. LINE_01499)
    assert.match(output, /LINE_01499/);
    // Should NOT contain the earliest lines (e.g. LINE_00000) because they rolled out
    assert.ok(!output.includes("LINE_00000_"));
  });

  it("supports incremental tailing via read(offset)", async () => {
    const session = new PtySession({
      command: "node",
      args: ["-e", "console.log(\"chunk1\"); setTimeout(() => console.log(\"chunk2\"), 100);"],
    });

    // Wait for first chunk
    for (let i = 0; i < 50; i++) {
      if (session.getOutput().includes("chunk1")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const read1 = session.read();
    assert.match(read1.output, /chunk1/);
    const offset1 = read1.nextOffset;

    // Wait for second chunk
    for (let i = 0; i < 50; i++) {
      if (session.getOutput().includes("chunk2")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const read2 = session.read(offset1);
    assert.match(read2.output, /chunk2/);
    assert.ok(!read2.output.includes("chunk1")); // Only incremental content returned

    await session.waitForExit(2000);
  });

  it("prevents writing to a terminated session", async () => {
    const session = new PtySession({
      command: "node",
      args: ["-e", "process.exit(0);"],
    });

    await session.waitForExit(2000);
    assert.equal(session.running, false);

    await assert.rejects(
      async () => {
        await session.write("should fail\n");
      },
      /Cannot write to stopped PTY session/
    );
  });

  it("sanitizes high-privilege credentials from environment inheritance", async () => {
    process.env.OPENAI_API_KEY = "super-secret-openai-token";
    process.env.OPENSAND_VAULT_PASSPHRASE = "vault-secret";

    const session = new PtySession({
      command: "node",
      args: ["-e", "console.log(\"key=\" + String(process.env.OPENAI_API_KEY) + \";vault=\" + String(process.env.OPENSAND_VAULT_PASSPHRASE));"],
    });

    await session.waitForExit(2000);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENSAND_VAULT_PASSPHRASE;

    const output = session.getOutput();
    assert.match(output, /key=undefined;vault=undefined/);
  });
});

describe("PtySessionManager", () => {
  it("creates, tracks, and lists active sessions", async () => {
    const manager = new PtySessionManager();
    const session1 = await manager.createSession({ command: "sleep 10" });
    const session2 = await manager.createSession({ command: "sleep 10" });

    assert.equal(manager.size, 2);
    assert.ok(manager.getSession(session1.id));
    assert.ok(manager.getSession(session2.id));

    const list = manager.listSessions();
    assert.equal(list.length, 2);
    const ids = list.map((s) => s.id);
    assert.ok(ids.includes(session1.id));
    assert.ok(ids.includes(session2.id));

    await manager.closeAll();
    assert.equal(manager.size, 0);
  });

  it("writes to session and reads incrementally via manager", async () => {
    const manager = new PtySessionManager();
    const session = await manager.createSession({ command: "cat" });

    await manager.writeToSession(session.id, "hello via manager\n");

    // Wait for echo
    for (let i = 0; i < 50; i++) {
      const res = manager.readSession(session.id);
      if (res.output.includes("hello via manager")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const read = manager.readSession(session.id);
    assert.match(read.output, /hello via manager/);

    const killed = await manager.killSession(session.id);
    assert.equal(killed, true);
    await manager.closeAll();
  });

  it("handles non-existent session IDs gracefully", async () => {
    const manager = new PtySessionManager();
    assert.equal(manager.getSession("non-existent"), undefined);
    assert.equal(await manager.killSession("non-existent"), false);

    await assert.rejects(
      async () => {
        await manager.writeToSession("non-existent", "test");
      },
      /PTY session not found/
    );

    assert.throws(
      () => {
        manager.readSession("non-existent");
      },
      /PTY session not found/
    );
  });
});

describe("ToolRegistry PTY Tools Integration", () => {
  it("registers and exposes 4 PTY tool definitions alongside core tools", () => {
    const registry = new ToolRegistry({ enablePty: true });
    const defs = registry.getDefinitions();

    assert.equal(defs.length, 11);
    const names = defs.map((d) => d.function.name);
    assert.ok(names.includes("pty_spawn"));
    assert.ok(names.includes("pty_write"));
    assert.ok(names.includes("pty_read"));
    assert.ok(names.includes("pty_kill"));
  });

  it("dispatches pty_spawn, pty_write, pty_read, and pty_kill workflow", async () => {
    const registry = new ToolRegistry({ enablePty: true });

    // 1. pty_spawn
    const spawnRes = await registry.dispatch("pty_spawn", {
      command: "cat",
    });

    assert.equal(spawnRes.status, "ok");
    assert.ok(spawnRes.output.session_id);
    const sessionId = spawnRes.output.session_id;

    // 2. pty_write
    const writeRes = await registry.dispatch("pty_write", {
      session_id: sessionId,
      data: "line from tool test\n",
    });

    assert.equal(writeRes.status, "ok");
    assert.ok(writeRes.output.bytesWritten > 0);

    // 3. pty_read
    let readRes: any = null;
    for (let i = 0; i < 50; i++) {
      readRes = await registry.dispatch("pty_read", { session_id: sessionId });
      if (readRes.status === "ok" && readRes.output.output.includes("line from tool test")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(readRes);
    assert.equal(readRes.status, "ok");
    assert.match(readRes.output.output, /line from tool test/);

    // 4. pty_kill
    const killRes = await registry.dispatch("pty_kill", {
      session_id: sessionId,
      signal: "SIGTERM",
    });

    assert.equal(killRes.status, "ok");
    assert.equal(killRes.output.killed, true);
    await registry.getPtyManager().closeAll();
  });

  it("enforces permission gates for pty_spawn when computerUse is disallowed", async () => {
    const registry = new ToolRegistry({ enablePty: true });

    const res = await registry.dispatch(
      "pty_spawn",
      { command: "bash" },
      {
        permissionGates: {
          computerUseAllowed: false,
          deviceToolsAllowed: false,
          standingAllowlist: [],
          standingGrants: [{ id: "g1", tool: "exec_command", scope: "ls *", lifetime: "always", epoch: 1, createdAt: 0 }],
        },
      }
    );

    assert.equal(res.status, "permission_pending");
    assert.equal(res.error?.code, "PERMISSION_REQUIRED");
    assert.ok(res.approvalId);
  });

  it("permits pty_spawn when approvalGranted is true or command is allowlisted", async () => {
    const registry = new ToolRegistry({ enablePty: true });

    const res = await registry.dispatch(
      "pty_spawn",
      { command: "echo approved-pty" },
      {
        permissionGates: {
          computerUseAllowed: false,
          deviceToolsAllowed: false,
          standingAllowlist: [],
        },
        approvalGranted: true,
      }
    );

    assert.equal(res.status, "ok");
    assert.ok(res.output.session_id);
    await registry.getPtyManager().closeAll();
  });
});
