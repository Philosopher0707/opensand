import type { CapabilityGrant } from "@opensand/shared";
/**
 * OpenSand Local Execution Daemon Type Definitions
 * Derived from reverse-engineered Sand local-exec protocol contracts.
 * ToolDefinition / ToolExecutionResult are canonical in @opensand/shared.
 */
export type { ToolDefinition, ToolExecutionResult } from "@opensand/shared";
import type { SandboxDenial } from "./sandbox/denials.js";

export type { SandboxProfileType } from "./sandbox/macos-profile.js";

export interface DaemonLivenessResult {
  running: boolean;
  pid?: number;
  generation?: number;
  stale: boolean;
}

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
  /** Derived, read-only legacy view of `standingGrants` (`git *` -> `git`). Nothing decides from it; writes are ignored. Removed in P4f PR4. */
  standingAllowlist: string[];
  /** The `always` exec_command grants of one grants.json snapshot. Missing means none, never "allow". */
  standingGrants?: CapabilityGrant[];
  /** Epoch of that snapshot; -1 when grants.json could not be read (it can never equal a real epoch). */
  grantsEpoch?: number;
  /** grants.json exists but could not be read or parsed: standing permission is denied. */
  grantsError?: true;
}

export interface ExecCommandInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
  sandboxProfile?: "read-only" | "workspace-write" | "full";
  workspaceRoot?: string;
  homeDir?: string;
  tempDir?: string;
  allowNetwork?: boolean;
  customProfileString?: string;
}

export interface ExecCommandOutput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the turn's abort signal stopped the command before it finished. */
  aborted?: boolean;
  /** Accesses the sandbox refused, read from stderr. Only set for sandboxed commands that hit one. */
  sandboxDenials?: SandboxDenial[];
}

export interface ReadFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
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
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
}


export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
}

export interface EditFileOutput {
  path: string;
  replacementCount: number;
  sha256: string;
  bytesWritten: number;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  max_results?: number;
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepOutput {
  matches: GrepMatch[];
  lines: string[];
  totalMatches: number;
  truncated: boolean;
}

export interface GlobInput {
  pattern: string;
  path?: string;
  max_results?: number;
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
}

export interface GlobOutput {
  matches: string[];
  totalMatches: number;
  truncated: boolean;
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
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
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

export interface PtySessionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  sandboxProfile?: "read-only" | "workspace-write" | "full";
  workspaceRoot?: string;
  homeDir?: string;
  tempDir?: string;
  allowNetwork?: boolean;
  customProfileString?: string;
}

export interface PtySessionSnapshot {
  id: string;
  pid: number;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  initError?: string;
}

export interface PtySessionChunk {
  type: "stdout" | "stderr" | "exit";
  text?: string;
  exitCode?: number | null;
}

export interface PtySpawnInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  sandboxProfile?: "read-only" | "workspace-write" | "full";
  workspaceRoot?: string;
  homeDir?: string;
  tempDir?: string;
  allowNetwork?: boolean;
  customProfileString?: string;
}

export interface PtyWriteInput {
  session_id: string;
  data: string;
}

export interface PtyReadInput {
  session_id: string;
  offset?: number;
}

export interface PtyReadOutput {
  id: string;
  output: string;
  offset: number;
  nextOffset: number;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
}

export interface PtyKillInput {
  session_id: string;
  signal?: string;
}
