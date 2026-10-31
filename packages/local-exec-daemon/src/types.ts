/**
 * OpenSand Local Execution Daemon Type Definitions
 * Derived from reverse-engineered Sand local-exec protocol contracts.
 */

export interface DaemonState {
  pid: number;
  startedAt: number;
  servingAt?: number;
  inflightCount: number;
  generation: number;
  filesKeyId?: string;
  rejectedAccountScopes?: string[];
  proxyFingerprint?: string;
}

export interface DaemonConnection {
  baseUrl: string;
  token?: string;
  headers?: Record<string, string>;
}

export interface DaemonSupervisorHeartbeat {
  pid: number;
  at: number;
}

export interface PermissionGates {
  computerUseAllowed: boolean;
  deviceToolsAllowed: boolean;
  standingAllowlist: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
        default?: any;
        items?: any;
      }>;
      required?: string[];
    };
  };
}

export interface ExecCommandInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
}

export interface ExecCommandOutput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface ReadFileOutput {
  path: string;
  totalLines: number;
  content: string;
  sha256: string;
  bytes: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
  sha256: string;
  created: boolean;
}

export interface ListDirectoryInput {
  path: string;
  recursive?: boolean;
  max_depth?: number;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAtMs: number;
}

export interface ListDirectoryOutput {
  path: string;
  entries: DirectoryEntry[];
}

export interface ToolExecutionResult<T = any> {
  status: "ok" | "error" | "permission_pending";
  output?: T;
  error?: {
    code: string;
    message: string;
  };
  approvalId?: string;
}
