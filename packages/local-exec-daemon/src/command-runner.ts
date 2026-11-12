import { spawn, type StdioOptions } from "node:child_process";
import { ExecCommandInput, ExecCommandOutput } from "./types.js";
import { validateBashCommand } from "./bash-validator.js";
import { generateMacosSandboxProfile } from "./sandbox/macos-profile.js";
import { SandboxInitializationError, type SandboxInitializationErrorOptions } from "./sandbox/errors.js";
import { resolveSandboxLauncher } from "./sandbox/launcher.js";
import { buildBwrapArgs } from "./sandbox/linux-bwrap.js";

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
    let stdio: StdioOptions = ["ignore", "pipe", "pipe"];
    let isSandboxed = false;
    let isBwrap = false;
    // Names the containment mechanism in errors; sandbox-exec is the default
    let sandboxOpts: SandboxInitializationErrorOptions = {};

    // Sandbox is opt-in via input.sandboxProfile, input.customProfileString, or OPENSAND_SANDBOX=1.
    // Once requested it is never dropped: when no containment is available the command is refused.
    const sandboxRequested = Boolean(
      input.sandboxProfile || input.customProfileString || process.env.OPENSAND_SANDBOX === "1"
    );

    if (sandboxRequested) {
      const launcher = resolveSandboxLauncher(process.platform, process.env);

      if (launcher.kind === "unavailable") {
        const mechanism =
          process.platform === "linux" ? "Linux bubblewrap" : process.platform === "darwin" ? undefined : process.platform;
        return reject(
          new SandboxInitializationError(launcher.reason, { mechanism, code: "SANDBOX_UNAVAILABLE" })
        );
      }

      if (launcher.kind === "sandbox-exec") {
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

        spawnCommand = launcher.path;
        spawnArgs = ["-p", profileString, "/bin/bash", "-c", input.command];
        isSandboxed = true;
      } else {
        if (input.customProfileString) {
          return reject(
            new SandboxInitializationError("customProfileString is macOS-only", { mechanism: "Linux bubblewrap" })
          );
        }

        spawnCommand = launcher.path;
        spawnArgs = [
          ...buildBwrapArgs({
            workspaceRoot: input.workspaceRoot ?? cwd,
            homeDir: input.homeDir,
            tempDir: input.tempDir,
            profile: input.sandboxProfile ?? "workspace-write",
            allowNetwork: input.allowNetwork,
          }),
          // bwrap writes its JSON info to fd 3 once the namespaces exist; an empty fd 3 means it never got that far
          "--info-fd",
          "3",
          "--",
          "/bin/bash",
          "-c",
          input.command,
        ];
        stdio = ["ignore", "pipe", "pipe", "pipe"];
        isSandboxed = true;
        isBwrap = true;
        sandboxOpts = { mechanism: "Linux bubblewrap" };
      }
    }

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env: { ...sanitizedEnv, ...(input.env ?? {}) },
        stdio,
      });
    } catch (err: any) {
      if (isSandboxed) {
        return reject(new SandboxInitializationError(`Spawn failed: ${err.message}`, sandboxOpts));
      }
      return reject(err);
    }

    let infoFdOutput = "";
    if (isBwrap) {
      child.stdio[3]?.on("data", (chunk: Buffer) => {
        infoFdOutput += chunk.toString("utf-8");
      });
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

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuffer.length < MAX_BUFFER_SIZE) {
        stdoutBuffer += chunk.toString("utf-8");
        if (stdoutBuffer.length >= MAX_BUFFER_SIZE) {
          stdoutBuffer += "\n[stdout truncated: exceeded 64KB buffer limit]";
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
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
          reject(new SandboxInitializationError(err.message, sandboxOpts));
        } else {
          reject(err);
        }
      }
    });

    child.on("close", (code, signal) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);

        // bwrap exited before it set up the namespaces (bad option, no user namespaces, broken binary): the command never ran
        if (isBwrap && infoFdOutput.length === 0) {
          reject(new SandboxInitializationError(stderrBuffer.trim() || `bwrap exited with code ${code}`, sandboxOpts));
          return;
        }

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
