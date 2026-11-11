export class SandboxInitializationError extends Error {
  constructor(reason: string) {
    super(`SandboxInitializationError: Failed to initialize macOS sandbox-exec containment: ${reason}`);
    this.name = "SandboxInitializationError";
  }
}
