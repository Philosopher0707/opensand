import { spawn } from "node:child_process";
import { ExecCommandInput, ExecCommandOutput } from "./types.js";
import { validateBashCommand } from "./bash-validator.js";

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

    const child = spawn("/bin/bash", ["-c", input.command], {
      cwd,
      env: { ...sanitizedEnv, ...(input.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

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
        reject(err);
      }
    });

    child.on("close", (code, signal) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
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
