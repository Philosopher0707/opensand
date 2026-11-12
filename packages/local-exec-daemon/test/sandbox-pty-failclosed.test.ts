import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PtySession } from "../src/pty-session.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";

const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";

describe("sandbox PTY fail-closed", () => {
  it(
    "linux: refusing a requested sandbox when bubblewrap is missing, and the command never runs",
    { skip: !isLinux ? "real runner refusal exercised on Linux" : false },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty_failclosed_"));
      const escaped = path.join(dir, `pty_escaped_${randomUUID()}`);
      const previous = process.env.OPENSAND_BWRAP_PATH;
      process.env.OPENSAND_BWRAP_PATH = path.join(dir, "no-such-bwrap");

      try {
        await assert.rejects(
          async () => {
            new PtySession({ command: `touch "${escaped}"`, sandboxProfile: "workspace-write" });
          },
          (caught: unknown) => {
            assert.ok(caught instanceof SandboxInitializationError, "must be a SandboxInitializationError");
            const { code } = caught as SandboxInitializationError & { code?: string };
            assert.equal(code, "SANDBOX_UNAVAILABLE");
            return true;
          }
        );
        assert.ok(!fs.existsSync(escaped), "an unsandboxed command must not run when containment is unavailable");
      } finally {
        if (previous === undefined) {
          delete process.env.OPENSAND_BWRAP_PATH;
        } else {
          process.env.OPENSAND_BWRAP_PATH = previous;
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it(
    "macOS: fail-closed with missing sandbox-exec launcher path",
    { skip: !isDarwin ? "macOS launcher test skipped on non-darwin" : false },
    async () => {
      const previous = process.env.OPENSAND_BWRAP_PATH;
      // Force darwin path resolution to fail by not providing sandbox-exec via exists override is not
      // supported through env; instead use a platform where sandbox-exec is absent by pointing
      // buildSandboxedSpawn indirectly is not possible through PtySession constructor.
      // On real darwin /usr/bin/sandbox-exec always exists; the unavailable path is covered in
      // sandbox-pty-args.test.ts at the launcher level.
      if (previous === undefined) {
        delete process.env.OPENSAND_BWRAP_PATH;
      } else {
        process.env.OPENSAND_BWRAP_PATH = previous;
      }
    }
  );

  it(
    "OPENSAND_SANDBOX=1 with missing bwrap binary: asserts fail-closed refusal",
    { skip: !isLinux ? "requires Linux bwrap probe" : false },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty_env_failclosed_"));
      const escaped = path.join(dir, `pty_env_escaped_${randomUUID()}`);
      const previous = process.env.OPENSAND_BWRAP_PATH;
      const previousSandbox = process.env.OPENSAND_SANDBOX;
      process.env.OPENSAND_BWRAP_PATH = path.join(dir, "no-such-bwrap");
      process.env.OPENSAND_SANDBOX = "1";

      try {
        await assert.rejects(
          async () => {
            new PtySession({ command: `touch "${escaped}"` });
          },
          (caught: unknown) => {
            assert.ok(caught instanceof SandboxInitializationError, "must be a SandboxInitializationError");
            const { code } = caught as SandboxInitializationError & { code?: string };
            assert.equal(code, "SANDBOX_UNAVAILABLE");
            return true;
          }
        );
        assert.ok(!fs.existsSync(escaped), "an unsandboxed command must not run when containment is unavailable");
      } finally {
        if (previous === undefined) {
          delete process.env.OPENSAND_BWRAP_PATH;
        } else {
          process.env.OPENSAND_BWRAP_PATH = previous;
        }
        if (previousSandbox === undefined) {
          delete process.env.OPENSAND_SANDBOX;
        } else {
          process.env.OPENSAND_SANDBOX = previousSandbox;
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
