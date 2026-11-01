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
    const SENSITIVE_VARS = [
      "OPENSAND_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ];
    for (const v of SENSITIVE_VARS) {
      if (!input.env || !(v in input.env)) {
        delete sanitizedEnv[v];
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

    const MAX_BUFFER_SIZE = 4 * 1024 * 1024; // 4MB frame limit

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBuffer.length < MAX_BUFFER_SIZE) {
        stdoutBuffer += chunk.toString("utf-8");
        if (stdoutBuffer.length >= MAX_BUFFER_SIZE) {
          stdoutBuffer += "\n[stdout truncated: exceeded 4MB buffer limit]";
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuffer.length < MAX_BUFFER_SIZE) {
        stderrBuffer += chunk.toString("utf-8");
        if (stderrBuffer.length >= MAX_BUFFER_SIZE) {
          stderrBuffer += "\n[stderr truncated: exceeded 4MB buffer limit]";
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
