import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { encodeLine, LineDecoder } from "@opensand/protocol";
import type { RequestFrame, SuccessResponseFrame, ErrorResponseFrame } from "@opensand/protocol";
import { runCommandOperation } from "../command-runner.js";
import {
  readFileOperation,
  writeFileOperation,
  editFileOperation,
  grepOperation,
  globOperation,
  listDirectoryOperation,
  resolveAndValidatePath,
} from "../file-ops.js";
import { WorkspaceEscapeError } from "../denial-errors.js";
import type {
  ExecCommandInput, ExecCommandOutput,
  ReadFileInput, ReadFileOutput, WriteFileInput, WriteFileOutput,
  EditFileInput, EditFileOutput, GrepInput, GrepOutput,
  GlobInput, GlobOutput, ListDirectoryInput, ListDirectoryOutput,
} from "../types.js";
import {
  TARGET_PROTOCOL_VERSION,
  TargetErrorCodes,
  type TargetHelloParams, type TargetHelloResult,
  type TargetExecParams, type TargetExecResult,
} from "./types.js";

/**
 * The `opensand-target --stdio` server (docs/design/phase8-reach.md §4.1).
 *
 * It calls the same operations as the local daemon with `workspaceRoot` set to
 * `--root` and `allowOutsideWorkspace` forced to false — the values on the wire
 * are never trusted. It has no model, no log and no keys of its own; the launcher
 * starts it with a small environment allowlist, which the bin also re-applies
 * so no secret can reach a child command even by inheritance.
 */

export interface TargetServerOptions {
  root: string;
  sandbox: "bwrap" | "none";
  /** Name recorded as OPENSAND_TARGET_ID in every exec's environment. */
  targetId: string;
  /** Server package version; defaults to the daemon package's own version. */
  version?: string;
}

const HELLO_METHOD = "target.hello";
const PING_METHOD = "target.ping";
const METHODS = new Set([
  HELLO_METHOD, PING_METHOD, "target.exec",
  "target.readFile", "target.writeFile", "target.editFile",
  "target.grep", "target.glob", "target.listDirectory",
]);

/** Environment keys the server may keep when the bin scrubs its own environment. */
export const TARGET_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM", "SHELL",
  "USER", "LOGNAME", "PWD", "OPENSAND_TARGET_ID", "OPENSAND_TARGET_SANDBOX",
]);

/** Secrets the launcher and the bin must never forward, including through explicit caller env. */
const NEVER_FORWARD = new Set([
  "SSH_AUTH_SOCK",
  "OPENSAND_VAULT_PASSPHRASE",
  "OPENSAND_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
]);
const SENSITIVE_SUFFIX = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSPHRASE)$/i;

export function sanitizeCallerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "OPENSAND_TARGET_ID") continue; // identity is forced by the server
    if (NEVER_FORWARD.has(key) || SENSITIVE_SUFFIX.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/** Bin startup: reduce the server's own environment to the allowlist, in place. */
export function scrubServerEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (!TARGET_ENV_ALLOWLIST.has(key)) delete env[key];
  }
}

/**
 * Resolve a wire path inside the root, including through symlinks: fail closed.
 * Walks the raw path segment by segment (never lexical-normalizing through a
 * symlink) so `link/../file` cannot hide a hop through a link that leaves the
 * root; every symlink target must resolve inside the root's real path.
 */
export async function resolveTargetPath(root: string, targetPath: string): Promise<string> {
  const rootResolved = path.resolve(root);
  const rootReal = await fs.promises.realpath(rootResolved);
  let raw = targetPath;
  if (path.isAbsolute(raw)) {
    const rel = path.relative(rootResolved, path.resolve(raw));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new WorkspaceEscapeError(
        `Path traversal blocked: absolute path "${targetPath}" resolves outside workspace root "${root}".`,
      );
    }
    raw = rel;
  }
  let current = rootReal;
  for (const part of raw.split(path.sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const next = path.dirname(current);
      if (next === current || !next.startsWith(rootReal)) {
        throw new WorkspaceEscapeError(
          `Path traversal blocked: target path "${targetPath}" escapes workspace root "${root}".`,
        );
      }
      current = next;
      continue;
    }
    const next = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Components that do not exist yet are only created inside the root;
        // walk on with the real path so far.
        current = next;
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(next);
      const abs = path.isAbsolute(target) ? target : path.resolve(path.dirname(next), target);
      const rel = path.relative(rootReal, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new WorkspaceEscapeError(
          `Path traversal blocked: target path "${targetPath}" resolves through the symlink "${part}" outside workspace root "${root}".`,
        );
      }
      current = await fs.promises.realpath(next);
      continue;
    }
    current = next;
  }
  const rel = path.relative(rootReal, current);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkspaceEscapeError(
      `Path traversal blocked: target path "${targetPath}" resolves outside workspace root "${root}".`,
    );
  }
  return current;
}

function readPackageVersion(): string {
  // Works in the worktree (packages/local-exec-daemon/...) and in the deployed
  // bundle (dist/target/...): both are three levels above dist/src/target/bin.js.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  const pkg = require(path.resolve(here, "../../../package.json")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/**
 * Parse one request line. The OSP frame parser (`parseLine`) enforces the
 * engine's namespace.Class.method name pattern, but the target link's methods
 * are two-part (`target.hello`, design §4.1), so the request side uses a
 * tolerant parser over the same wire format; responses keep the OSP shape.
 */
function parseTargetRequest(line: string): RequestFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    throw new Error(`Malformed JSON line: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Frame must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error("id must be a non-empty string");
  if (typeof record.method !== "string" || record.method.length === 0) throw new Error("method must be a string");
  if (record.params !== undefined && (typeof record.params !== "object" || record.params === null || Array.isArray(record.params))) {
    throw new Error("params must be an object");
  }
  return { id: record.id, method: record.method, params: (record.params ?? {}) as Record<string, unknown> };
}

export class TargetServer {
  public readonly root: string;
  public readonly sandbox: "bwrap" | "none";
  public readonly targetId: string;
  public readonly version: string;
  public readonly marker: string;

  private helloDone = false;
  private decoder = new LineDecoder();
  private busy: Promise<void> = Promise.resolve();

  constructor(options: TargetServerOptions) {
    const root = path.resolve(options.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`--root must be an existing directory: ${root}`);
    }
    this.root = root;
    this.sandbox = options.sandbox;
    this.targetId = options.targetId;
    this.version = options.version ?? readPackageVersion();
    this.marker = randomBytes(12).toString("hex");
  }

  /**
   * Handle one chunk of stdin; returns the framed response lines (possibly
   * several, and empty for a line that cannot be parsed). Requests are handled
   * one at a time, in arrival order.
   */
  async handleChunk(chunk: string): Promise<string> {
    const lines = this.decoder.push(chunk);
    let out = "";
    for (const line of lines) {
      out += await this.enqueue(line);
    }
    return out;
  }

  private enqueue(line: string): Promise<string> {
    const run = this.busy.then(() => this.handleLine(line));
    // Keep the queue alive even when a request fails; the caller already got the rejection.
    this.busy = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleLine(line: string): Promise<string> {
    let request: RequestFrame;
    try {
      const frame = parseTargetRequest(line);
      if (!("method" in frame)) {
        // Responses and events have no meaning on the server side.
        return "";
      }
      request = frame;
    } catch (err) {
      process.stderr.write(`opensand-target: ignoring malformed line: ${(err as Error).message}\n`);
      return "";
    }
    if (!METHODS.has(request.method)) {
      return this.errorFrame(request, -32601, `unknown method ${request.method}`);
    }
    if (request.method !== HELLO_METHOD && !this.helloDone) {
      return this.errorFrame(request, TargetErrorCodes.NotReady, "the first request must be target.hello");
    }
    try {
      const result = await this.dispatch(request);
      const frame: SuccessResponseFrame = { id: request.id, result };
      return encodeLine(frame);
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -32603;
      return this.errorFrame(request, code, (err as Error).message);
    }
  }

  private errorFrame(request: RequestFrame, code: number, message: string): string {
    const frame: ErrorResponseFrame = { id: request.id, error: { code, message } };
    return encodeLine(frame);
  }

  private async dispatch(request: RequestFrame): Promise<unknown> {
    switch (request.method) {
      case HELLO_METHOD: return this.hello(request.params);
      case PING_METHOD: return { ok: true };
      case "target.exec": return this.exec(request.params as unknown as TargetExecParams | undefined);
      case "target.readFile": return readFileOperation(await this.fileParams<ReadFileInput>(request.params, "path"));
      case "target.writeFile": return writeFileOperation(await this.fileParams<WriteFileInput>(request.params, "path"));
      case "target.editFile": return editFileOperation(await this.fileParams<EditFileInput>(request.params, "path"));
      case "target.grep": return grepOperation(await this.fileParams<GrepInput>(request.params, "path", true));
      case "target.glob": return globOperation(await this.fileParams<GlobInput>(request.params, "path", true));
      case "target.listDirectory": return listDirectoryOperation(await this.fileParams<ListDirectoryInput>(request.params, "path", true));
      default: throw new Error(`unknown method ${request.method}`);
    }
  }

  private hello(params: unknown): TargetHelloResult {
    const input = params as Partial<TargetHelloParams> | undefined;
    if (input?.protocol !== TARGET_PROTOCOL_VERSION) {
      throw Object.assign(
        new Error(
          `target-version-mismatch: client protocol ${String(input?.protocol)} != server protocol ${TARGET_PROTOCOL_VERSION}`,
        ),
        { code: TargetErrorCodes.VersionMismatch },
      );
    }
    if (typeof input.clientVersion !== "string" || input.clientVersion !== this.version) {
      throw Object.assign(
        new Error(
          `target-version-mismatch: client version ${JSON.stringify(input?.clientVersion ?? null)} != server version ${this.version}; redeploy the target bundle`,
        ),
        { code: TargetErrorCodes.VersionMismatch },
      );
    }
    this.helloDone = true;
    const result: TargetHelloResult = {
      protocol: TARGET_PROTOCOL_VERSION,
      version: this.version,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      root: this.root,
      sandbox: this.sandbox,
      marker: this.marker,
    };
    return result;
  }

  private async exec(params: TargetExecParams | undefined): Promise<TargetExecResult> {
    if (!params || typeof params.command !== "string") {
      throw new Error('"command" is required for target.exec');
    }
    const cwd = params.cwd ? await resolveTargetPath(this.root, params.cwd) : this.root;
    // Identity is forced last so a caller env can never override it.
    const input: ExecCommandInput = {
      command: params.command,
      cwd,
      timeout_ms: params.timeoutMs,
      env: { OPENSAND_TARGET_ID: this.targetId, ...(params.env ? sanitizeCallerEnv(params.env) : {}) },
      workspaceRoot: this.root,
    };
    return runCommandOperation(input);
  }

  /**
   * Copy a wire input for a file operation: resolve its path inside the root
   * (symlinks included) and force the workspace root and containment flags so
   * nothing on the wire can widen them.
   */
  private async fileParams<T extends { path?: string; workspaceRoot?: string; allowOutsideWorkspace?: boolean }>(
    params: unknown,
    pathKey: string,
    optionalPath = false,
  ): Promise<T> {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("params must be an object");
    }
    const copy = { ...(params as Record<string, unknown>) };
    const rawPath = copy[pathKey];
    if (rawPath === undefined || rawPath === null) {
      if (!optionalPath) throw new Error(`"${pathKey}" is required`);
      copy[pathKey] = this.root;
    } else {
      if (typeof rawPath !== "string") throw new Error(`"${pathKey}" must be a string`);
      copy[pathKey] = await resolveTargetPath(this.root, rawPath);
    }
    copy.workspaceRoot = this.root;
    copy.allowOutsideWorkspace = false;
    return copy as T;
  }
}

/**
 * Serve stdio: reads stdin until EOF, writes framed responses to stdout,
 * diagnostics to stderr. stdout carries nothing but framed responses.
 */
export async function serveTargetStdio(server: TargetServer, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  let writing = Promise.resolve();
  const stdin = input as fs.ReadStream;
  stdin.setEncoding("utf8");
  const write = (chunk: string) => {
    writing = writing.then(() => new Promise<void>((resolve) => { output.write(chunk, "utf8", () => resolve()); }));
  };
  for await (const chunk of stdin) {
    const out = await server.handleChunk(String(chunk));
    if (out.length > 0) write(out);
  }
  await writing;
}
