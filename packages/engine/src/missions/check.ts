import { runCommandOperation } from "@opensand/local-exec-daemon";

export interface CheckSpec {
  command: string;
  timeoutMs?: number;
  sandbox?: "read-only" | "workspace-write" | "full";
}

export interface CheckResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTail: string;
  passed: boolean;
}

/**
 * Executes a harness check script inside the workspace.
 * passed is exitCode === 0 && signal === null, computed here and nowhere else.
 */
export async function runCheck(
  spec: CheckSpec,
  workspaceRoot: string,
  opts?: { signal?: AbortSignal }
): Promise<CheckResult> {
  const result = await runCommandOperation(
    {
      command: spec.command,
      cwd: workspaceRoot,
      workspaceRoot,
      timeout_ms: spec.timeoutMs,
      sandboxProfile: spec.sandbox,
    },
    opts
  );

  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  const tailLimit = 4 * 1024;
  const outputTail =
    Buffer.byteLength(combined, "utf8") <= tailLimit
      ? combined
      : Buffer.from(combined, "utf8").subarray(-tailLimit).toString("utf8");

  const passed = result.exitCode === 0 && result.signal === null;

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    outputTail,
    passed,
  };
}
