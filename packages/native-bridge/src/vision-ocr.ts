import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { VisionResult } from "./types.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function isSupportedImage(buf: Buffer, n: number): boolean {
  if (n < 4) return false;
  // PNG
  if (n >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return true;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // TIFF little-endian
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) return true;
  // TIFF big-endian
  if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // WebP: RIFF....WEBP
  if (n >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  // HEIC/HEIF: ftyp box
  if (n >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.toString("ascii", 8, 12);
    if (/heic|heif|mif1|msf1|avif/i.test(brand)) return true;
  }
  return false;
}

export async function recognizeScreenText(
  imagePath: string,
  binDir?: string
): Promise<VisionResult> {
  const resolvedImage = path.resolve(imagePath);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolvedImage);
  } catch {
    return {
      status: "error",
      message: `Image file does not exist: ${resolvedImage}`,
    };
  }

  // Refuse oversized images before spawning the helper.
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      status: "error",
      message: "Image exceeds the 20 MB size limit.",
    };
  }

  // Refuse unsupported image types before spawning the helper.
  try {
    const handle = await fs.open(resolvedImage, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buf, 0, 12, 0);
    await handle.close();
    if (!isSupportedImage(buf, bytesRead)) {
      return {
        status: "error",
        message: "Unsupported image format.",
      };
    }
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
    let isSettled = false;

    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        child.kill("SIGKILL");
        resolve({
          status: "error",
          message: "sand-vision OCR timed out after 20000ms",
        });
      }
    }, 20000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);

      if (code !== 0) {
        // Keep the helper's structured stdout rejection (e.g. unsupported format).
        try {
          const parsed = JSON.parse(stdoutBuffer.trim());
          if (parsed && typeof parsed === "object" && typeof parsed.message === "string") {
            resolve({
              status: parsed.status === "ok" ? "ok" : "error",
              message: parsed.message,
            });
            return;
          }
        } catch {
          // fall through to stderr
        }
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
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve({
        status: "error",
        message: `Failed to spawn sand-vision: ${err.message}`,
      });
    });
  });
}
