import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { VisionResult } from "./types.js";

export async function recognizeScreenText(
  imagePath: string,
  binDir?: string
): Promise<VisionResult> {
  const resolvedImage = path.resolve(imagePath);
  try {
    await fs.stat(resolvedImage);
  } catch {
    return {
      status: "error",
      message: `Image file does not exist: ${resolvedImage}`,
    };
  }

  let binPath = binDir ? path.join(binDir, "sand-vision") : path.join(import.meta.dirname, "..", "..", "bin", "sand-vision");
  try {
    await fs.stat(binPath);
  } catch {
    binPath = path.join(import.meta.dirname, "..", "bin", "sand-vision");
  }

  let executable = binPath;
  let args = [resolvedImage];

  // Check if compiled binary exists
  let hasBinary = false;
  try {
    await fs.stat(binPath);
    hasBinary = true;
  } catch {
    hasBinary = false;
  }

  if (!hasBinary) {
    // If not compiled, attempt running swift script directly
    const swiftSource = path.join(import.meta.dirname, "..", "native", "sand-vision.swift");
    try {
      await fs.stat(swiftSource);
      executable = "/usr/bin/swift";
      args = [swiftSource, resolvedImage];
    } catch {
      return {
        status: "error",
        message: "Neither compiled sand-vision binary nor sand-vision.swift source was found.",
      };
    }
  }

  return new Promise((resolve) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const child = spawn(executable, args, {
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
          message: stderrBuffer || `sand-vision exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdoutBuffer.trim());
        resolve(parsed);
      } catch (err: any) {
        resolve({
          status: "error",
          message: `Failed to parse Vision JSON response: ${err.message}`,
        });
      }
    });

    child.on("error", (err) => {
      resolve({
        status: "error",
        message: `Failed to spawn sand-vision: ${err.message}`,
      });
    });
  });
}
