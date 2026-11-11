import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { runCommandOperation } from "../src/command-runner.js";
import { generateMacosSandboxProfile } from "../src/sandbox/macos-profile.js";

const isDarwin = process.platform === "darwin";

if (!isDarwin) {
  console.log("macOS sandbox tests skipped on non-darwin platform");
}

describe(
  "macOS Sandbox Profile",
  { skip: !isDarwin ? "macOS sandbox tests skipped on non-darwin platform" : false },
  () => {
    it("generates valid TinyScheme profiles for all profiles and network options", () => {
      const ws = "/tmp/sandbox_ws_dummy";

      // 1. workspace-write (default)
      const wsProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "workspace-write",
      });
      assert.match(wsProfile, /\(version 1\)/);
      assert.match(wsProfile, /\(allow default\)/);
      assert.match(wsProfile, /\(deny network\*\)/);
      assert.match(wsProfile, /\(deny file-read\* \(subpath ".*\.ssh"\)\)/);
      assert.match(wsProfile, /\(deny file-read\* \(subpath ".*\.opensand\/vault"\)\)/);
      assert.match(wsProfile, /\(deny file-read\* \(literal ".*\.bashrc"\)\)/);
      assert.match(wsProfile, /\(deny file-read\* \(literal ".*\.zshrc"\)\)/);
      assert.match(wsProfile, /\(deny file-write\*\)/);
      assert.match(wsProfile, /\(allow file-write\* \(subpath ".*sandbox_ws_dummy"\)\)/);
      assert.match(wsProfile, /\(allow file-write\* \(literal "\/dev\/null"\)/);

      // 2. read-only
      const roProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "read-only",
      });
      assert.match(roProfile, /\(deny file-write\*\)/);
      assert.ok(!roProfile.includes(`(allow file-write* (subpath "${ws}")`));
      assert.match(roProfile, /\(allow file-write\* \(literal "\/dev\/null"\)/);

      // 3. full
      const fullProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "full",
      });
      assert.equal(fullProfile.trim(), "(version 1)\n(allow default)");

      // 4. allowNetwork: true
      const netProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "workspace-write",
        allowNetwork: true,
      });
      assert.ok(!netProfile.includes("(deny network*)"));
    });

    it("fails when writing outside the workspace (Test 1)", async () => {
      const uuid = randomUUID();
      const escapeFile = path.join("/tmp", `sandbox_escape_test_${uuid}.txt`);
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_test_ws_"));

      try {
        const res = await runCommandOperation({
          command: `touch ${escapeFile}`,
          cwd: wsDir,
          workspaceRoot: wsDir,
        });

        assert.notEqual(res.exitCode, 0, "Execution should exit non-zero when writing outside workspace");
        assert.match(res.stderr, /Operation not permitted/);
        assert.ok(!fs.existsSync(escapeFile), "File outside workspace should not be created");
      } finally {
        if (fs.existsSync(escapeFile)) {
          try {
            fs.unlinkSync(escapeFile);
          } catch {}
        }
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("fails when reading ~/.ssh (Test 2)", async () => {
      const res = await runCommandOperation({
        command: 'ls -la "$HOME/.ssh" 2>&1 || true',
      });

      const combined = res.stdout + res.stderr;
      assert.match(combined, /Operation not permitted/);
    });

    it("succeeds for normal command inside workspace (Test 3)", async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_test_ws_"));
      try {
        const res = await runCommandOperation({
          command: 'echo "hello" > inside.txt && cat inside.txt',
          cwd: wsDir,
          workspaceRoot: wsDir,
        });

        assert.equal(res.exitCode, 0);
        assert.equal(res.stdout.trim(), "hello");
        assert.equal(res.stderr, "");
      } finally {
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("enforces read-only profile denying writes even inside workspace", async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_test_ws_"));
      try {
        const res = await runCommandOperation({
          command: 'echo "read-only test" > inside.txt',
          cwd: wsDir,
          workspaceRoot: wsDir,
          sandboxProfile: "read-only",
        });

        assert.notEqual(res.exitCode, 0);
        assert.match(res.stderr, /Operation not permitted/);
      } finally {
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("permits unconstrained execution under full profile", async () => {
      const uuid = randomUUID();
      const tempFile = path.join("/tmp", `sandbox_full_test_${uuid}.txt`);
      try {
        const res = await runCommandOperation({
          command: `echo "full-ok" > "${tempFile}" && cat "${tempFile}"`,
          sandboxProfile: "full",
        });

        assert.equal(res.exitCode, 0);
        assert.equal(res.stdout.trim(), "full-ok");
      } finally {
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch {}
        }
      }
    });
  }
);
