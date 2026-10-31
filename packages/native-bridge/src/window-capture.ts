import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { WindowListResult, CaptureResult } from "./types.js";

import * as fsSync from "node:fs";

function getCaptureBinary(binDir?: string): { executable: string; baseArgs: string[] } {
  if (binDir) {
    return { executable: path.join(binDir, "sand-window-capture"), baseArgs: [] };
  }
  const candidateDist = path.join(import.meta.dirname, "..", "..", "bin", "sand-window-capture");
  const candidateSrc = path.join(import.meta.dirname, "..", "bin", "sand-window-capture");
  const binPath = fsSync.existsSync(candidateDist) ? candidateDist : candidateSrc;
  return { executable: binPath, baseArgs: [] };
}

export async function listWindows(binDir?: string): Promise<WindowListResult> {
  const { executable } = getCaptureBinary(binDir);

  let runExec = executable;
  let args = ["--list"];

  try {
    await fs.stat(executable);
  } catch {
    const swiftSource = path.join(import.meta.dirname, "..", "native", "sand-window-capture.swift");
    runExec = "/usr/bin/swift";
    args = [swiftSource, "--list"];
  }

  return new Promise((resolve) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const child = spawn(runExec, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          status: "error",
          message: stderrBuffer || `listWindows exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdoutBuffer.trim());
        resolve(parsed);
      } catch (err: any) {
        resolve({
          status: "error",
          message: `Failed to parse window list JSON: ${err.message}`,
        });
      }
    });

    child.on("error", (err) => {
      resolve({
        status: "error",
        message: `Failed to spawn sand-window-capture: ${err.message}`,
      });
    });
  });
}

export async function captureWindow(
  windowId: number,
  outputPath: string
): Promise<CaptureResult> {
  const resolvedOut = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOut), { recursive: true });

  return new Promise((resolve) => {
    let stderrBuffer = "";

    // Direct native screencapture execution
    const child = spawn("/usr/sbin/screencapture", [`-l${windowId}`, "-o", resolvedOut], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          status: "error",
          windowId,
          message: stderrBuffer || `screencapture exited with code ${code}`,
        });
        return;
      }

      resolve({
        status: "ok",
        windowId,
        path: resolvedOut,
      });
    });

    child.on("error", (err) => {
      resolve({
        status: "error",
        windowId,
        message: `Failed to spawn screencapture: ${err.message}`,
      });
    });
  });
}
