import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PtySession } from "../src/pty-session.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";

const isDarwin = process.platform === "darwin";

if (!isDarwin) {
  console.log("macOS sandbox PTY tests skipped on non-darwin platform");
}

function makeFixture(): { base: string; workspace: string; outside: string; home: string; tempDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_pty_macos_test_"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const home = path.join(base, "fake-home");
  const tempDir = path.join(base, "session-tmp");
  for (const dir of [workspace, outside, home, tempDir, path.join(home, ".ssh")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { base, workspace, outside, home, tempDir };
}

const SECRET_MARKER = "SANDBOX_PTY_MACOS_SECRET_4f8a";

describe(
  "macOS sandbox-exec PTY containment",
  { skip: !isDarwin ? "macOS sandbox PTY tests skipped on non-darwin platform" : false },
  () => {
    it("1. write outside the workspace fails and creates no file", async () => {
      const fx = makeFixture();
      const uuid = randomUUID();
      const escapeFile = path.join(fx.outside, `sandbox_pty_escape_test_${uuid}.txt`);
      try {
        const session = new PtySession({
          command: `touch "${escapeFile}"`,
          cwd: fx.workspace,
          workspaceRoot: fx.workspace,
          tempDir: fx.tempDir,
          sandboxProfile: "workspace-write",
        });
        const snapshot = await session.waitForExit(10000);
        assert.notEqual(snapshot.exitCode, 0, "write outside workspace must exit non-zero");
        assert.match(session.getOutput(), /Operation not permitted/);
        assert.ok(!fs.existsSync(escapeFile), "file outside workspace should not be created");
      } finally {
        if (fs.existsSync(fx.base)) {
          try {
            fs.rmSync(fx.base, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("2. secret files in the fake home cannot be read from inside the sandbox", async () => {
      const fx = makeFixture();
      try {
        const fakeSsh = path.join(fx.home, ".ssh");
        fs.mkdirSync(fakeSsh, { recursive: true });
        const fakeKeyPath = path.join(fakeSsh, "id_test");
        fs.writeFileSync(fakeKeyPath, SECRET_MARKER, "utf8");

        const wsDir = path.join(fx.workspace, "ws");
        fs.mkdirSync(wsDir, { recursive: true });

        const session = new PtySession({
          command: `cat "${fakeKeyPath}"`,
          cwd: wsDir,
          workspaceRoot: wsDir,
          homeDir: fx.home,
          sandboxProfile: "workspace-write",
        });
        await session.waitForExit(10000);
        const output = session.getOutput();
        assert.ok(!output.includes(SECRET_MARKER), "secret content must not leak in PTY output");
      } finally {
        if (fs.existsSync(fx.base)) {
          try {
            fs.rmSync(fx.base, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("3. normal command inside workspace succeeds", async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_pty_test_ws_"));
      try {
        const session = new PtySession({
          command: 'echo "hello" > inside.txt && cat inside.txt',
          cwd: wsDir,
          workspaceRoot: wsDir,
          sandboxProfile: "workspace-write",
        });
        const snapshot = await session.waitForExit(10000);
        assert.equal(snapshot.exitCode, 0);
        assert.match(session.getOutput(), /hello/);
      } finally {
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("4. read-only profile denies writes even inside workspace", async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_pty_test_ws_"));
      try {
        const session = new PtySession({
          command: 'echo "read-only test" > inside.txt',
          cwd: wsDir,
          workspaceRoot: wsDir,
          sandboxProfile: "read-only",
        });
        const snapshot = await session.waitForExit(10000);
        assert.notEqual(snapshot.exitCode, 0);
        assert.match(session.getOutput(), /Operation not permitted/);
      } finally {
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("5. network cut by default", async () => {
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
        if (fs.existsSync(fx.base)) {
          try {
            fs.rmSync(fx.base, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("6. OPENSAND_SANDBOX=1 alone contains a PTY session that was not given a profile", async () => {
      const fx = makeFixture();
      const origEnv = process.env.OPENSAND_SANDBOX;
      process.env.OPENSAND_SANDBOX = "1";
      const uuid = randomUUID();
      const escapeFile = path.join(fx.outside, `sandbox_pty_env_escape_${uuid}.txt`);
      try {
        const session = new PtySession({
          command: `touch "${escapeFile}"`,
          cwd: fx.workspace,
          workspaceRoot: fx.workspace,
          homeDir: fx.home,
          tempDir: fx.tempDir,
        });
        const snapshot = await session.waitForExit(10000);
        assert.notEqual(snapshot.exitCode, 0, "OPENSAND_SANDBOX=1 must contain the session");
        assert.ok(!fs.existsSync(escapeFile), "file outside workspace must not be created");
      } finally {
        if (origEnv !== undefined) {
          process.env.OPENSAND_SANDBOX = origEnv;
        } else {
          delete process.env.OPENSAND_SANDBOX;
        }
        if (fs.existsSync(fx.base)) {
          try {
            fs.rmSync(fx.base, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("7. malformed customProfileString triggers sandbox-exec code 65 and is classified as SandboxInitializationError", async () => {
      const session = new PtySession({
        command: "echo fail_closed_test",
        customProfileString: "(invalid-scheme-syntax-missing-paren",
      });
      const snapshot = await session.waitForExit(10000);
      assert.ok(session.initializationError instanceof SandboxInitializationError, "must record initError");
      assert.equal(session.initializationError!.mechanism, "macOS sandbox-exec");
      assert.match(session.getOutput(), /Sandbox initialization failed/);
    });
  }
);
