export interface ExternalEngineConfig {
  type: "external";
  engine: "claude" | "codex" | "copilot" | "antigravity" | "opencode" | "workbuddy";
  model?: string;
  binaryPath?: string;
  timeoutMs?: number;
  idleMs?: number;
  mode?: "plan" | "agent" | "ask" | "auto_edit";
}

export interface EngineDetectionResult {
  engine: string;
  label: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  versionStatus: "tested" | "newer" | "older" | "unknown" | "unchecked";
  authenticated: boolean;
  authMessage?: string;
  models: Array<{ id: string; label: string }>;
  modelsSource: "live" | "fallback" | "error";
  modelsMessage?: string;
}
