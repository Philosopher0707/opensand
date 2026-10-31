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

    const child = spawn("/bin/bash", ["-c", input.command], {
      cwd,
      env: { ...process.env, ...(input.env ?? {}) },
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
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
