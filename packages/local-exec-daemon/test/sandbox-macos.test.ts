import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { runCommandOperation } from "../src/command-runner.js";
import { generateMacosSandboxProfile } from "../src/sandbox/macos-profile.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";
import { DENIED_SECRET_REL_PATHS } from "../src/sandbox/constants.js";

const isDarwin = process.platform === "darwin";

if (!isDarwin) {
  console.log("macOS sandbox tests skipped on non-darwin platform");
}

describe(
  "macOS Sandbox Profile",
  { skip: !isDarwin ? "macOS sandbox tests skipped on non-darwin platform" : false },
  () => {
    it("exports DENIED_SECRET_REL_PATHS containing all required secret targets", () => {
      const required = [
        ".ssh",
        ".aws",
        ".gnupg",
        ".config",
        ".netrc",
        ".bashrc",
        ".bash_profile",
        ".profile",
        ".zshrc",
        ".zprofile",
        ".zshenv",
        ".opensand/vault",
      ];
      for (const req of required) {
        assert.ok(
          (DENIED_SECRET_REL_PATHS as readonly string[]).includes(req),
          `DENIED_SECRET_REL_PATHS must include ${req}`
        );
      }
    });

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

      // 3. full (default allowNetwork: false -> (deny network*))
      const fullProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "full",
      });
      assert.equal(fullProfile.trim(), "(version 1)\n(allow default)\n(deny network*)");

      // 4. full with allowNetwork: true
      const fullNetProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "full",
        allowNetwork: true,
      });
      assert.equal(fullNetProfile.trim(), "(version 1)\n(allow default)");

      // 5. workspace-write with allowNetwork: true
      const netProfile = generateMacosSandboxProfile({
        workspaceRoot: ws,
        profile: "workspace-write",
        allowNetwork: true,
      });
      assert.ok(!netProfile.includes("(deny network*)"));
    });

    it("fails when writing outside the workspace (Test 1)", async () => {
      const uuid = randomUUID();
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_containment_test_"));
      const outsideDir = path.join(baseDir, "outside");
      const wsDir = path.join(baseDir, "workspace");
      const isolatedTemp = path.join(baseDir, "temp");

      fs.mkdirSync(outsideDir, { recursive: true });
      fs.mkdirSync(wsDir, { recursive: true });
      fs.mkdirSync(isolatedTemp, { recursive: true });

      const escapeFile = path.join(outsideDir, `sandbox_escape_test_${uuid}.txt`);

      try {
        const res = await runCommandOperation({
          command: `touch "${escapeFile}"`,
          cwd: wsDir,
          workspaceRoot: wsDir,
          tempDir: isolatedTemp,
          sandboxProfile: "workspace-write",
        });

        assert.notEqual(res.exitCode, 0, "Execution should exit non-zero when writing outside workspace");
        assert.match(res.stderr, /Operation not permitted/);
        assert.ok(!fs.existsSync(escapeFile), "File outside workspace should not be created");
      } finally {
        if (fs.existsSync(baseDir)) {
          try {
            fs.rmSync(baseDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("fails when reading secrets in hermetic fake home (Test 2)", async () => {
      const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_fake_home_test_"));
      const fakeHome = path.join(baseTmp, "fake-home");
      const fakeSsh = path.join(fakeHome, ".ssh");
      fs.mkdirSync(fakeSsh, { recursive: true });

      const secretToken = `super_secret_ssh_key_token_${randomUUID()}`;
      const fakeKeyPath = path.join(fakeSsh, "id_test");
      fs.writeFileSync(fakeKeyPath, secretToken, "utf8");

      const wsDir = path.join(baseTmp, "ws");
      fs.mkdirSync(wsDir, { recursive: true });

      try {
        const res = await runCommandOperation({
          command: `cat "${fakeKeyPath}"`,
          cwd: wsDir,
          workspaceRoot: wsDir,
          homeDir: fakeHome,
          sandboxProfile: "workspace-write",
        });

        assert.notEqual(res.exitCode, 0, "Reading .ssh key must exit non-zero");
        assert.match(res.stderr, /Operation not permitted/);
        assert.ok(!res.stdout.includes(secretToken), "Secret content must not leak in stdout");
        assert.ok(!res.stderr.includes(secretToken), "Secret content must not leak in stderr");
      } finally {
        if (fs.existsSync(baseTmp)) {
          try {
            fs.rmSync(baseTmp, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("succeeds for normal command inside workspace (Test 3)", async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_test_ws_"));
      try {
        const res = await runCommandOperation({
          command: 'echo "hello" > inside.txt && cat inside.txt',
          cwd: wsDir,
          workspaceRoot: wsDir,
          sandboxProfile: "workspace-write",
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

    it("succeeds for temp directory writes and mktemp (Test 3 extension)", async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_test_ws_"));
      try {
        const cmd = `
          TFILE=$(mktemp)
          echo "temp_ok" > "$TFILE"
          cat "$TFILE"
          rm -f "$TFILE"
          node -e "const fs = require('fs'); const os = require('os'); const p = require('path').join(os.tmpdir(), 'node_t.txt'); fs.writeFileSync(p, 'ok'); console.log('node_wrote_ok'); fs.unlinkSync(p);"
        `;
        const res = await runCommandOperation({
          command: cmd,
          cwd: wsDir,
          workspaceRoot: wsDir,
          sandboxProfile: "workspace-write",
        });

        assert.equal(res.exitCode, 0);
        assert.match(res.stdout, /temp_ok/);
        assert.match(res.stdout, /node_wrote_ok/);
      } finally {
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    it("enforces fail-closed behaviour when sandbox initialization fails (Test 4)", async () => {
      // 1. Direct error class verification
      const err = new SandboxInitializationError("Test container confinement failure");
      assert.ok(err instanceof SandboxInitializationError);
      assert.match(err.message, /SandboxInitializationError/);

      // 2. Real process execution failure handling: malformed syntax causes sandbox-exec exit 65, rejecting with SandboxInitializationError
      await assert.rejects(
        async () => {
          await runCommandOperation({
            command: "echo fail_closed_test",
            customProfileString: "(invalid-scheme-syntax-missing-paren",
          });
        },
        (caught: any) => {
          assert.ok(caught instanceof SandboxInitializationError, "Error must be instance of SandboxInitializationError");
          assert.match(caught.message, /syntax error|Failed to initialize macOS sandbox-exec/);
          return true;
        }
      );
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

    it("respects OPENSAND_SANDBOX=1 environment variable for opt-in", async () => {
      const origEnv = process.env.OPENSAND_SANDBOX;
      process.env.OPENSAND_SANDBOX = "1";
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_env_ws_"));
      try {
        const res = await runCommandOperation({
          command: 'echo "env sandbox ok" > inside.txt && cat inside.txt',
          cwd: wsDir,
          workspaceRoot: wsDir,
        });

        assert.equal(res.exitCode, 0);
        assert.equal(res.stdout.trim(), "env sandbox ok");
      } finally {
        if (origEnv !== undefined) {
          process.env.OPENSAND_SANDBOX = origEnv;
        } else {
          delete process.env.OPENSAND_SANDBOX;
        }
        if (fs.existsSync(wsDir)) {
          try {
            fs.rmSync(wsDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });
  }
);
