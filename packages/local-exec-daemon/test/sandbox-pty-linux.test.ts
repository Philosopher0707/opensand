import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PtySession } from "../src/pty-session.js";
import { PtySessionManager } from "../src/pty-manager.js";
import { resolveSandboxLauncher } from "../src/sandbox/launcher.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";

// Real bubblewrap needs Linux, a bwrap binary and unprivileged user namespaces.
function bwrapSkipReason(): string | false {
  if (process.platform !== "linux") return "bubblewrap PTY tests run on Linux only";
  const launcher = resolveSandboxLauncher("linux", process.env);
  if (launcher.kind !== "bwrap") return "no bwrap binary found";
  const probe = spawnSync(launcher.path, ["--ro-bind", "/", "/", "true"], { encoding: "utf8" });
  if (probe.status !== 0) return `bwrap probe failed (user namespaces unavailable): ${probe.stderr.trim()}`;
  return false;
}

const skip = bwrapSkipReason();
if (skip) {
  console.log(`bubblewrap PTY tests skipped: ${skip}`);
}

function makeFixture(): { base: string; workspace: string; outside: string; home: string; tempDir: string } {
  const base = fs.mkdtempSync(path.join(os.homedir(), "sandbox_pty_linux_test_"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const home = path.join(base, "fake-home");
  const tempDir = path.join(base, "session-tmp");
  for (const dir of [workspace, outside, home, tempDir, path.join(home, ".ssh")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { base, workspace, outside, home, tempDir };
}

const SECRET_MARKER = "SANDBOX_PTY_SECRET_MARKER_9c2e";

describe("bubblewrap PTY containment", { skip: skip || false }, () => {
  it("1. write outside the workspace fails and creates no file", async () => {
    const fx = makeFixture();
    try {
      const target = path.join(fx.outside, "pty_escape.txt");
      const session = new PtySession({
        command: `echo x > "${target}"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      const snapshot = await session.waitForExit(10000);
      assert.notEqual(snapshot.exitCode, 0, "write outside the workspace must fail");
      assert.ok(!fs.existsSync(target), "file outside the workspace must not be created");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("2. secret files in the fake home cannot be read from inside the sandbox", async () => {
    const fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.home, ".ssh", "id_rsa"), SECRET_MARKER);
      fs.writeFileSync(path.join(fx.home, ".netrc"), SECRET_MARKER);
      const session = new PtySession({
        command: `cat "${fx.home}/.ssh/id_rsa"; cat "${fx.home}/.netrc"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      await session.waitForExit(10000);
      const output = session.getOutput();
      assert.ok(!output.includes(SECRET_MARKER), "secret must not appear in session output");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("3. writes inside the workspace succeed", async () => {
    const fx = makeFixture();
    try {
      const session = new PtySession({
        command: `echo ok > "${fx.workspace}/pty_inside.txt"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      const snapshot = await session.waitForExit(10000);
      assert.equal(snapshot.exitCode, 0, `write inside workspace must succeed: ${session.getOutput()}`);
      assert.ok(fs.existsSync(path.join(fx.workspace, "pty_inside.txt")));
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("4. read-only profile refuses a write inside the workspace", async () => {
    const fx = makeFixture();
    try {
      const session = new PtySession({
        command: `echo x > "${fx.workspace}/pty_inside.txt"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "read-only",
      });
      const snapshot = await session.waitForExit(10000);
      assert.notEqual(snapshot.exitCode, 0, "read-only profile must refuse writes");
      assert.ok(!fs.existsSync(path.join(fx.workspace, "pty_inside.txt")), "file must not be created");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("5. network is cut by default", async () => {
    const fx = makeFixture();
    try {
      const session = new PtySession({
        command: "exec 3<>/dev/tcp/1.1.1.1/53",
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      const snapshot = await session.waitForExit(10000);
      assert.notEqual(snapshot.exitCode, 0, "outbound connection must fail without allowNetwork");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("6. OPENSAND_SANDBOX=1 alone contains a PTY session that was not given a profile", async () => {
    const fx = makeFixture();
    const previous = process.env.OPENSAND_SANDBOX;
    process.env.OPENSAND_SANDBOX = "1";
    try {
      const target = path.join(fx.outside, "pty_env-escape.txt");
      const session = new PtySession({
        command: `echo x > "${target}"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
      });
      const snapshot = await session.waitForExit(10000);
      assert.notEqual(snapshot.exitCode, 0, "OPENSAND_SANDBOX=1 must contain the session");
      assert.ok(!fs.existsSync(target), "file outside workspace must not be created");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAND_SANDBOX;
      } else {
        process.env.OPENSAND_SANDBOX = previous;
      }
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("7. PTY init failure detection: a bwrap that prints 'bwrap:' and exits 1 raises SandboxInitializationError", async () => {
    const fx = makeFixture();
    const fakeBwrap = path.join(fx.base, "fake-bwrap");
    fs.writeFileSync(
      fakeBwrap,
      "#!/bin/sh\necho 'bwrap: Can't mount proc on /proc: Permission denied' >&2\nexit 1\n",
      { mode: 0o755 }
    );
    const previous = process.env.OPENSAND_BWRAP_PATH;
    process.env.OPENSAND_BWRAP_PATH = fakeBwrap;
    try {
      const session = new PtySession({
        command: "true",
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      const snapshot = await session.waitForExit(10000);
      assert.ok(session.initializationError instanceof SandboxInitializationError, "must record initError");
      assert.equal(session.initializationError!.mechanism, "Linux bubblewrap");
      assert.match(session.getOutput(), /Sandbox initialization failed/);
      assert.match(session.getOutput(), /bwrap:/);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAND_BWRAP_PATH;
      } else {
        process.env.OPENSAND_BWRAP_PATH = previous;
      }
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });
});
