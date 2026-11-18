import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry, clampSandboxProfile } from "../src/tool-registry.js";
import type { PtySessionManager } from "../src/pty-manager.js";

describe("sandbox profile clamp", () => {
  it("never lets a call widen the turn's profile", () => {
    assert.equal(clampSandboxProfile("full", "read-only"), "read-only");
    assert.equal(clampSandboxProfile("full", "workspace-write"), "workspace-write");
    assert.equal(clampSandboxProfile("workspace-write", "read-only"), "read-only");
    assert.equal(clampSandboxProfile("read-only", "workspace-write"), "read-only");
    assert.equal(clampSandboxProfile(undefined, "read-only"), "read-only");
    assert.equal(clampSandboxProfile("full", undefined), "full");
    assert.equal(clampSandboxProfile(undefined, undefined), undefined);
  });

  it("pty_spawn asking for full under a read-only turn reaches the manager as read-only", async () => {
    const seen: any[] = [];
    const manager = {
      createSession: async (opts: any) => {
        seen.push(opts);
        return { id: "s1", getSnapshot: () => ({}) };
      },
    } as unknown as PtySessionManager;
    const registry = new ToolRegistry({ ptyManager: manager, enablePty: true });
    const res = await registry.dispatch(
      "pty_spawn",
      { command: "echo hi", sandboxProfile: "full" },
      { workspaceRoot: "/tmp", sandboxProfile: "read-only" },
    );
    assert.equal(res.status, "ok");
    assert.equal(seen[0].sandboxProfile, "read-only");
    seen.length = 0;
    await registry.dispatch(
      "pty_spawn",
      { command: "echo hi", sandboxProfile: "full" },
      { workspaceRoot: "/tmp", sandboxProfile: "workspace-write" },
    );
    assert.equal(seen[0].sandboxProfile, "workspace-write");
  });

  it("exec_command asking for full under a read-only turn cannot write", { skip: process.platform !== "darwin" }, async () => {
    const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-clamp-")));
    try {
      const target = path.join(ws, "should-not-exist");
      const registry = new ToolRegistry();
      await registry.dispatch(
        "exec_command",
        { command: `touch ${target}`, sandboxProfile: "full" },
        { workspaceRoot: ws, sandboxProfile: "read-only" },
      );
      assert.equal(fs.existsSync(target), false);
      // control: the same call under workspace-write does write
      await registry.dispatch(
        "exec_command",
        { command: `touch ${target}`, sandboxProfile: "full" },
        { workspaceRoot: ws, sandboxProfile: "workspace-write" },
      );
      assert.equal(fs.existsSync(target), true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// Model-supplied containment fields must never widen the turn's sandbox. The turn context
// (workspaceRoot, sandboxProfile) is the only trusted source.
describe("model input cannot widen the sandbox", () => {
  // A plain string only: the fake manager never touches the filesystem.
  const turnRoot = path.join(os.homedir(), "opensand-turn-root");
  const fakePtyManager = (seen: any[]) =>
    ({
      createSession: async (opts: any) => {
        seen.push(opts);
        return { id: "s1", getSnapshot: () => ({}) };
      },
    }) as unknown as PtySessionManager;
  const realDir = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-input-")));

  it("pty_spawn ignores a model workspaceRoot", async () => {
    const seen: any[] = [];
    const registry = new ToolRegistry({ ptyManager: fakePtyManager(seen), enablePty: true });
    await registry.dispatch("pty_spawn", { command: "true", workspaceRoot: "/" }, { workspaceRoot: turnRoot, sandboxProfile: "read-only" });
    assert.equal(seen[0].workspaceRoot, turnRoot);
  });

  it("pty_spawn ignores a model customProfileString", async () => {
    const seen: any[] = [];
    const registry = new ToolRegistry({ ptyManager: fakePtyManager(seen), enablePty: true });
    await registry.dispatch(
      "pty_spawn",
      { command: "true", customProfileString: "(version 1)(allow default)" },
      { workspaceRoot: turnRoot, sandboxProfile: "read-only" },
    );
    assert.equal(seen[0].customProfileString, undefined);
  });

  it("pty_spawn ignores a model allowNetwork", async () => {
    const seen: any[] = [];
    const registry = new ToolRegistry({ ptyManager: fakePtyManager(seen), enablePty: true });
    await registry.dispatch("pty_spawn", { command: "true", allowNetwork: true }, { workspaceRoot: turnRoot, sandboxProfile: "read-only" });
    assert.equal(seen[0].allowNetwork, undefined);
  });

  it("pty_spawn ignores a model homeDir and tempDir", async () => {
    const seen: any[] = [];
    const registry = new ToolRegistry({ ptyManager: fakePtyManager(seen), enablePty: true });
    await registry.dispatch(
      "pty_spawn",
      { command: "true", homeDir: "/", tempDir: "/" },
      { workspaceRoot: turnRoot, sandboxProfile: "read-only" },
    );
    assert.equal(seen[0].homeDir, undefined);
    assert.equal(seen[0].tempDir, undefined);
  });

  it("pty_spawn and exec_command keep cwd inside the turn workspace", async () => {
    const ws = realDir();
    const outside = realDir();
    try {
      const seen: any[] = [];
      const registry = new ToolRegistry({ ptyManager: fakePtyManager(seen), enablePty: true });
      await registry.dispatch("pty_spawn", { command: "true", cwd: outside }, { workspaceRoot: ws });
      assert.equal(seen[0].cwd, ws);
      await registry.dispatch("pty_spawn", { command: "true", cwd: "sub" }, { workspaceRoot: ws });
      assert.equal(seen[1].cwd, path.join(ws, "sub"));
      const res = await new ToolRegistry().dispatch("exec_command", { command: "pwd", cwd: outside }, { workspaceRoot: ws });
      assert.equal(res.status, "ok");
      assert.equal((res.output as { stdout: string }).stdout.trim(), ws);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  describe("exec_command (macOS sandbox)", { skip: process.platform !== "darwin" }, () => {
    it("ignores a model workspaceRoot: the write outside the turn root is denied", async () => {
      const ws = realDir();
      // The default profile keeps TMPDIR writable, so the outside dir must not live under it.
      const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), "opensand-input-outside-")));
      try {
        const target = path.join(outside, "should-not-exist");
        await new ToolRegistry().dispatch(
          "exec_command",
          { command: `touch ${target}`, workspaceRoot: outside },
          { workspaceRoot: ws, sandboxProfile: "workspace-write" },
        );
        assert.equal(fs.existsSync(target), false);
        // control: the same write inside the turn root does happen
        await new ToolRegistry().dispatch(
          "exec_command",
          { command: `touch ${path.join(ws, "ok")}` },
          { workspaceRoot: ws, sandboxProfile: "workspace-write" },
        );
        assert.equal(fs.existsSync(path.join(ws, "ok")), true);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("ignores a model customProfileString under a read-only turn", async () => {
      const ws = realDir();
      try {
        const target = path.join(ws, "should-not-exist");
        await new ToolRegistry().dispatch(
          "exec_command",
          { command: `touch ${target}`, customProfileString: "(version 1)(allow default)" },
          { workspaceRoot: ws, sandboxProfile: "read-only" },
        );
        assert.equal(fs.existsSync(target), false);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("ignores a model allowNetwork under a read-only turn", async () => {
      const ws = realDir();
      const hits: string[] = [];
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? "");
        res.end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as { port: number };
        await new ToolRegistry().dispatch(
          "exec_command",
          { command: `curl -sS -m 3 -o /dev/null http://127.0.0.1:${port}/net`, allowNetwork: true },
          { workspaceRoot: ws, sandboxProfile: "read-only" },
        );
        assert.equal(hits.length, 0);
      } finally {
        server.close();
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("ignores a model homeDir and tempDir: a write outside the turn root stays denied", async () => {
      const ws = realDir();
      // Under read-only no temp dir is writable, so the write must be tested under workspace-write.
      const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), "opensand-input-outside-")));
      try {
        const target = path.join(outside, "should-not-exist");
        await new ToolRegistry().dispatch(
          "exec_command",
          { command: `touch ${target}`, homeDir: outside, tempDir: outside },
          { workspaceRoot: ws, sandboxProfile: "workspace-write" },
        );
        assert.equal(fs.existsSync(target), false);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
