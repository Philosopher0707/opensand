export type SandboxErrorCode = "SANDBOX_INIT_FAILED" | "SANDBOX_UNAVAILABLE";

export interface SandboxInitializationErrorOptions {
  mechanism?: string;
  code?: SandboxErrorCode;
}

export class SandboxInitializationError extends Error {
  readonly code: SandboxErrorCode;
  readonly mechanism: string;

  constructor(reason: string, opts: SandboxInitializationErrorOptions = {}) {
    const mechanism = opts.mechanism ?? "macOS sandbox-exec";
    super(`SandboxInitializationError: Failed to initialize ${mechanism} containment: ${reason}`);
    this.name = "SandboxInitializationError";
    this.code = opts.code ?? "SANDBOX_INIT_FAILED";
    this.mechanism = mechanism;
  }
}
