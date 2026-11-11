import fs from "node:fs";
import { spawn } from "node:child_process";
import { ExecCommandInput, ExecCommandOutput } from "./types.js";
import { validateBashCommand } from "./bash-validator.js";
import { generateMacosSandboxProfile } from "./sandbox/macos-profile.js";
import { SandboxInitializationError } from "./sandbox/errors.js";

export async function runCommandOperation(input: ExecCommandInput): Promise<ExecCommandOutput> {
  // 1. Pre-flight bash validation
  const validation = validateBashCommand(input.command);
  if (!validation.valid) {
    throw new Error(`Bash syntax error: ${validation.error}`);
  }
  if (validation.isDangerous) {
    throw new Error(`Dangerous command blocked by safety gate: ${validation.dangerReason}`);
  }

  const startTime = Date.now();
  const timeoutMs = input.timeout_ms ?? 60000;
  const cwd = input.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let isSettled = false;

    // Sanitize high-privilege credentials from child process inheritance by default
    const sanitizedEnv: Record<string, string | undefined> = { ...process.env };
    const SENSITIVE_VARS = new Set([
      "OPENSAND_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "SLACK_BOT_TOKEN",
      "LINEAR_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "SSH_AUTH_SOCK",
      "OPENSAND_VAULT_PASSPHRASE",
    ]);

    for (const key of Object.keys(sanitizedEnv)) {
      const isSensitive =
        SENSITIVE_VARS.has(key) ||
        (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSPHRASE)$/i.test(key) && !key.startsWith("npm_"));
      if (isSensitive && (!input.env || !(key in input.env))) {
        delete sanitizedEnv[key];
      }
    }

    let spawnCommand = "/bin/bash";
    let spawnArgs = ["-c", input.command];
    let isSandboxed = false;

    // Sandbox is opt-in via input.sandboxProfile, input.customProfileString, or OPENSAND_SANDBOX=1
    const sandboxRequested = Boolean(
      input.sandboxProfile || input.customProfileString || process.env.OPENSAND_SANDBOX === "1"
    );

    if (sandboxRequested) {
      if (process.platform === "darwin") {
        if (!fs.existsSync("/usr/bin/sandbox-exec")) {
          return reject(new SandboxInitializationError("/usr/bin/sandbox-exec binary not found"));
        }

        let profileString = input.customProfileString;
        if (!profileString) {
          const sandboxProfile = input.sandboxProfile ?? "workspace-write";
          const workspaceRoot = input.workspaceRoot ?? cwd;

          try {
            profileString = generateMacosSandboxProfile({
              workspaceRoot,
              homeDir: input.homeDir,
              tempDir: input.tempDir,
              profile: sandboxProfile,
              allowNetwork: input.allowNetwork,
            });
          } catch (err: any) {
            return reject(new SandboxInitializationError(`Profile generation failed: ${err.message}`));
          }
        }

        spawnCommand = "/usr/bin/sandbox-exec";
        spawnArgs = ["-p", profileString, "/bin/bash", "-c", input.command];
        isSandboxed = true;
      } else {
        // Non-darwin platforms fallback to standard spawn or recorded warning until bubblewrap in PR 2
      }
    }

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env: { ...sanitizedEnv, ...(input.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      if (isSandboxed) {
        return reject(new SandboxInitializationError(`Spawn failed: ${err.message}`));
      }
      return reject(err);
    }

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 2000).unref();

        resolve({
          exitCode: null,
          signal: "SIGTERM",
          stdout: stdoutBuffer,
          stderr: stderrBuffer + `\n[Command timed out after ${timeoutMs}ms]`,
          durationMs: Date.now() - startTime,
        });
      }
    }, timeoutMs);

    const MAX_BUFFER_SIZE = 64 * 1024; // 64KB output buffer limit to prevent context flooding

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBuffer.length < MAX_BUFFER_SIZE) {
        stdoutBuffer += chunk.toString("utf-8");
        if (stdoutBuffer.length >= MAX_BUFFER_SIZE) {
          stdoutBuffer += "\n[stdout truncated: exceeded 64KB buffer limit]";
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuffer.length < MAX_BUFFER_SIZE) {
        stderrBuffer += chunk.toString("utf-8");
        if (stderrBuffer.length >= MAX_BUFFER_SIZE) {
          stderrBuffer += "\n[stderr truncated: exceeded 64KB buffer limit]";
        }
      }
    });

    child.on("error", (err) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        if (isSandboxed) {
          reject(new SandboxInitializationError(err.message));
        } else {
          reject(err);
        }
      }
    });

    child.on("close", (code, signal) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);

        // Check if sandbox-exec itself failed during initialization (e.g. invalid profile syntax or container restriction)
        if (isSandboxed && code === 65 && stderrBuffer.includes("sandbox-exec:")) {
          reject(new SandboxInitializationError(stderrBuffer.trim()));
          return;
        }

        resolve({
          exitCode: code,
          signal: signal ? String(signal) : null,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          durationMs: Date.now() - startTime,
        });
      }
    });
  });
}
