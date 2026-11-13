import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogLock } from "./event-log-lock.js";
import type { CapabilityGrant, GrantsFileContent } from "./grants-types.js";

export const STALE_EPOCH_CODE = 4001;

export class StaleEpochError extends Error {
  public readonly code = STALE_EPOCH_CODE;
  public readonly requestEpoch: number | undefined;
  public readonly currentEpoch: number;

  constructor(requestEpoch: number | undefined, currentEpoch: number) {
    super(
      requestEpoch === undefined
        ? `Approval carries no epoch (current epoch ${currentEpoch}); refusing to act`
        : `Approval epoch ${requestEpoch} is stale (current epoch ${currentEpoch})`,
    );
    this.name = "StaleEpochError";
    this.requestEpoch = requestEpoch;
    this.currentEpoch = currentEpoch;
  }
}

export interface GrantsStoreOptions {
  /** Directory holding grants.json. Default: $OPENSAND_STATE_DIR, else ~/.opensand. */
  baseDir?: string;
  updatedBy?: string;
  lockTimeoutMs?: number;
}

export type NewGrant = Omit<CapabilityGrant, "id" | "epoch" | "createdAt"> & Partial<Pick<CapabilityGrant, "id">>;

const FILE_NAME = "grants.json";

function emptyContent(updatedBy: string): GrantsFileContent {
  return { version: 1, epoch: 1, grants: [], updatedAt: Date.now(), updatedBy };
}

export class GrantsStore {
  public readonly baseDir: string;
  public readonly filePath: string;
  private readonly updatedBy: string;
  private readonly lockTimeoutMs: number;

  constructor(options: GrantsStoreOptions = {}) {
    this.baseDir = options.baseDir ?? process.env.OPENSAND_STATE_DIR ?? path.join(os.homedir(), ".opensand");
    this.filePath = path.join(this.baseDir, FILE_NAME);
    this.updatedBy = options.updatedBy ?? "shared:grants-store";
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  }

  private parse(raw: string): GrantsFileContent {
    const parsed = JSON.parse(raw) as GrantsFileContent;
    if (parsed?.version !== 1 || typeof parsed.epoch !== "number" || !Array.isArray(parsed.grants)) {
      throw new Error(`Invalid grants file at ${this.filePath}`);
    }
    return parsed;
  }

  /** Lock-free read: writers replace the file atomically, so a reader sees a whole file. */
  public async read(): Promise<GrantsFileContent> {
    try {
      return this.parse(await fsp.readFile(this.filePath, "utf8"));
    } catch (err: any) {
      if (err.code === "ENOENT") return emptyContent(this.updatedBy);
      throw err;
    }
  }

  public readSync(): GrantsFileContent {
    try {
      return this.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err: any) {
      if (err.code === "ENOENT") return emptyContent(this.updatedBy);
      throw err;
    }
  }

  public getEpochSync(): number {
    return this.readSync().epoch;
  }

  private async persist(content: GrantsFileContent): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.baseDir, `.${FILE_NAME}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
      await fsp.writeFile(tmp, JSON.stringify(content, null, 2), { encoding: "utf8", mode: 0o600 });
      await fsp.rename(tmp, this.filePath);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Read-modify-write under the cross-process lock. */
  private async writeGrants<T>(fn: (content: GrantsFileContent) => T): Promise<T> {
    await fsp.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const lock = await EventLogLock.acquire(this.baseDir, { timeoutMs: this.lockTimeoutMs, lockFileName: "grants.lock" });
    try {
      const content = await this.read();
      const result = fn(content);
      content.updatedAt = Date.now();
      content.updatedBy = this.updatedBy;
      await this.persist(content);
      return result;
    } finally {
      await lock.release();
    }
  }

  /** Adding authority never bumps the epoch. */
  public async addGrant(input: NewGrant): Promise<CapabilityGrant> {
    return this.writeGrants((content) => {
      const grant: CapabilityGrant = {
        ...input,
        id: input.id ?? `grant_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        epoch: content.epoch,
        createdAt: Date.now(),
      };
      content.grants.push(grant);
      return grant;
    });
  }

  /** Narrowing authority bumps the epoch by exactly one. Returns the new epoch, or the unchanged one if the grant was unknown. */
  public async revokeGrant(id: string): Promise<{ revoked: boolean; epoch: number }> {
    return this.writeGrants((content) => {
      const before = content.grants.length;
      content.grants = content.grants.filter((g) => g.id !== id);
      if (content.grants.length === before) return { revoked: false, epoch: content.epoch };
      content.epoch += 1;
      return { revoked: true, epoch: content.epoch };
    });
  }

  /**
   * Fail closed: a missing or non-matching epoch is refused with StaleEpochError (code 4001).
   */
  public async assertEpoch(requestEpoch: unknown): Promise<number> {
    const current = (await this.read()).epoch;
    if (typeof requestEpoch !== "number" || requestEpoch !== current) {
      throw new StaleEpochError(typeof requestEpoch === "number" ? requestEpoch : undefined, current);
    }
    return current;
  }
}

export interface ToolExecutionQuery {
  tool: string;
  command?: string;
  cwd?: string;
  path?: string;
  domain?: string;
}

function scopeMatches(scope: string, q: ToolExecutionQuery): boolean {
  if (scope === "*") return true;
  if (q.command !== undefined) {
    if (scope.endsWith(" *")) {
      const prefix = scope.slice(0, -2);
      return q.command === prefix || q.command.startsWith(prefix + " ");
    }
    if (q.command === scope) return true;
  }
  const target = q.path ?? q.cwd;
  if (target !== undefined && scope.startsWith("/")) {
    const normalized = scope.replace(/\/+$/, "");
    return target === normalized || target.startsWith(normalized + "/");
  }
  if (q.domain !== undefined) {
    if (scope.startsWith("*.")) return q.domain.endsWith(scope.slice(1));
    return q.domain === scope;
  }
  return false;
}

export function isToolExecutionGranted(
  grants: readonly CapabilityGrant[],
  query: ToolExecutionQuery,
  now: number = Date.now(),
): boolean {
  return grants.some(
    (g) => g.tool === query.tool && (g.expiresAt === undefined || g.expiresAt > now) && scopeMatches(g.scope, query),
  );
}
