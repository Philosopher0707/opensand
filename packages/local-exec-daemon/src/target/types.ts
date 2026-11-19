import { ExecCommandOutput, ReadFileInput, ReadFileOutput, WriteFileInput, WriteFileOutput, EditFileInput, EditFileOutput, GrepInput, GrepOutput, GlobInput, GlobOutput, ListDirectoryInput, ListDirectoryOutput } from "../types.js";

/**
 * The opensand-target link (docs/design/phase8-reach.md §4).
 * The wire reuses OSP line framing (encodeLine/parseLine) with the method
 * namespace `target.*`. Errors use integer codes like every OSP error frame.
 */

/** Exact protocol version. A client and server that disagree refuse the link. */
export const TARGET_PROTOCOL_VERSION = 1;

/** Error codes carried in the response frame's error.code. */
export const TargetErrorCodes = {
  /** Protocol or package version mismatch: refuse before any workspace change. */
  VersionMismatch: 5001,
  /** A non-hello request arrived before a successful handshake. */
  NotReady: 5002,
  /** The link died (child exited or a request timed out). */
  Lost: 5003,
  /** A second holder of the target/workspace lock (used by S3). */
  Busy: 5004,
  /** Preflight found the runtime missing or without node >= 22. */
  ToolchainMissing: 5005,
} as const;

export interface TargetHelloParams {
  protocol: number;
  clientVersion: string;
}

export interface TargetHelloResult {
  protocol: number;
  version: string;
  platform: string;
  arch: string;
  node: string;
  root: string;
  sandbox: "bwrap" | "none";
  /** Random per-server-process token: proves which server instance answered. */
  marker: string;
}

export interface TargetExecParams {
  command: string;
  /** Relative to the target root, or absolute under it; defaults to the root. */
  cwd?: string;
  timeoutMs?: number;
  /** Explicit additions to the child environment; secrets are stripped. */
  env?: Record<string, string>;
}

export type TargetExecResult = ExecCommandOutput;

export type TargetReadFileParams = ReadFileInput;
export type TargetReadFileResult = ReadFileOutput;
export type TargetWriteFileParams = WriteFileInput;
export type TargetWriteFileResult = WriteFileOutput;
export type TargetEditFileParams = EditFileInput;
export type TargetEditFileResult = EditFileOutput;
export type TargetGrepParams = GrepInput;
export type TargetGrepResult = GrepOutput;
export type TargetGlobParams = GlobInput;
export type TargetGlobResult = GlobOutput;
export type TargetListDirectoryParams = ListDirectoryInput;
export type TargetListDirectoryResult = ListDirectoryOutput;

export interface TargetPingResult {
  ok: true;
}

export class TargetLinkError extends Error {
  public readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "TargetLinkError";
    this.code = code;
  }
}

export class TargetVersionMismatchError extends TargetLinkError {
  constructor(message: string) {
    super(TargetErrorCodes.VersionMismatch, message);
    this.name = "TargetVersionMismatchError";
  }
}

/** Link lost mid-mission: the command's outcome is unknown and is never retried. */
export class TargetLostError extends TargetLinkError {
  constructor(message: string) {
    super(TargetErrorCodes.Lost, message);
    this.name = "TargetLostError";
  }
}

export class TargetNotReadyError extends TargetLinkError {
  constructor(message: string) {
    super(TargetErrorCodes.NotReady, message);
    this.name = "TargetNotReadyError";
  }
}
