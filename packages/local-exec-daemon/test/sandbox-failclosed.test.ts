import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommandOperation } from "../src/command-runner.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";

// On macOS /usr/bin/sandbox-exec always exists, so the unavailable path is covered at the
// launcher level in sandbox-linux-args.test.ts instead. This file drives the real runner on Linux.
const isLinux = process.platform === "linux";

describe(
  "sandbox fail-closed",
  { skip: !isLinux ? "real runner refusal is exercised on Linux; macOS uses the launcher table" : false },
  () => {
    it("refuses a requested sandbox when bubblewrap is missing, and the command never runs", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_failclosed_"));
      const escaped = path.join(dir, `escaped_${randomUUID()}`);
      const previous = process.env.OPENSAND_BWRAP_PATH;
      process.env.OPENSAND_BWRAP_PATH = path.join(dir, "no-such-bwrap");

      try {
        await assert.rejects(
          runCommandOperation({
            command: `touch "${escaped}"`,
            cwd: dir,
            workspaceRoot: dir,
            tempDir: dir,
            sandboxProfile: "workspace-write",
          }),
          (caught: unknown) => {
            assert.ok(caught instanceof SandboxInitializationError, "must be a SandboxInitializationError");
            // Typed loosely so this file also compiles on trees where the error has no code yet
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
    });
  }
);
