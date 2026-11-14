import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
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
