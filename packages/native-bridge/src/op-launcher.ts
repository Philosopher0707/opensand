import { spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { OpExecInput, OpExecOutput } from "./types.js";

/**
 * Returns Seatbelt Sandbox profile isolating 1Password group container paths.
 */
export function buildSeatbeltProfile(restrictedSubpaths: string[] = []): string {
  const defaultPaths = [
    path.join(os.homedir(), "Library", "Group Containers", "2BUA8C4S2C.com.1password"),
    path.join(os.homedir(), "Library", "Application Support", "1Password"),
  ];

  const allPaths = [...defaultPaths, ...restrictedSubpaths];
  const denyRules = allPaths
    .map((p) => `  (deny file-read* (with no-report) (subpath "${p}"))`)
    .join("\n");

  return `(version 1)
(allow default)
${denyRules}
`;
}

export async function runOpHardened(
  input: OpExecInput,
  options: { opBinaryPath?: string; timeoutMs?: number } = {}
): Promise<OpExecOutput> {
  const opBin = options.opBinaryPath ?? "op";
  const profile = buildSeatbeltProfile();
  const timeoutMs = options.timeoutMs ?? 30000;

  const fullArgs = ["-p", profile, opBin, ...input.subcommand];
  if (input.account) {
    fullArgs.push("--account", input.account);
  }
  if (input.vault) {
    fullArgs.push("--vault", input.vault);
  }

  return new Promise((resolve) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let isSettled = false;

    const child = spawn("sandbox-exec", fullArgs, {
      env: {
        ...process.env,
        OP_BIOMETRIC_UNLOCK_ENABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        child.kill("SIGKILL");
        resolve({
          exitCode: 124,
          stdout: stdoutBuffer,
          stderr: stderrBuffer + `\n[Command timed out after ${timeoutMs}ms]`,
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
        resolve({
          exitCode: 1,
          stdout: stdoutBuffer,
          stderr: `Failed to spawn sandbox-exec: ${err.message}`,
        });
      }
    });

    child.on("close", (code) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
        });
      }
    });
  });
}
