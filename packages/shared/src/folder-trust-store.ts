import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "./atomic-json.js";
import { GrantsStore } from "./grants-store.js";
import { TRUST_RANK, type FolderTrustFileContent, type TrustLevel } from "./folder-trust-types.js";

const FILE_NAME = "folder-trust.json";
const LEVELS: readonly string[] = ["untrusted", "prompt", "trusted"];

export interface FolderTrustStoreOptions {
  /** Same resolution as GrantsStore: $OPENSAND_STATE_DIR, else ~/.opensand. */
  baseDir?: string;
  updatedBy?: string;
  lockTimeoutMs?: number;
  /** Share the caller's GrantsStore so the lock and epoch are the same ones. */
  grants?: GrantsStore;
}

export class FolderTrustStore {
  public readonly baseDir: string;
  public readonly filePath: string;
  public readonly grants: GrantsStore;
  private readonly updatedBy: string;

  constructor(options: FolderTrustStoreOptions = {}) {
    this.baseDir = options.baseDir ?? process.env.OPENSAND_STATE_DIR ?? path.join(os.homedir(), ".opensand");
    this.filePath = path.join(this.baseDir, FILE_NAME);
    this.updatedBy = options.updatedBy ?? "shared:folder-trust-store";
    this.grants =
      options.grants ??
      new GrantsStore({ baseDir: this.baseDir, updatedBy: this.updatedBy, lockTimeoutMs: options.lockTimeoutMs });
  }

  /** Throws when the path does not exist: a lexical fallback would let a symlink launder trust. */
  public static canonicalFolder(p: string): string {
    return fs.realpathSync.native(p);
  }

  private static levelFromRaw(raw: string, key: string): TrustLevel {
    try {
      const parsed = JSON.parse(raw) as FolderTrustFileContent;
      if (parsed?.version !== 1 || typeof parsed.folders !== "object" || parsed.folders === null) return "prompt";
      if (!Object.prototype.hasOwnProperty.call(parsed.folders, key)) return "prompt";
      const level = parsed.folders[key]?.level;
      return typeof level === "string" && LEVELS.includes(level) ? (level as TrustLevel) : "prompt";
    } catch {
      return "prompt";
    }
  }

  /** Lock-free read. Anything absent, corrupt or unknown is "prompt", never "trusted". */
  public async getLevel(folder: string): Promise<TrustLevel> {
    const key = FolderTrustStore.canonicalFolder(folder);
    try {
      return FolderTrustStore.levelFromRaw(await fsp.readFile(this.filePath, "utf8"), key);
    } catch {
      return "prompt";
    }
  }

  public getLevelSync(folder: string): TrustLevel {
    const key = FolderTrustStore.canonicalFolder(folder);
    try {
      return FolderTrustStore.levelFromRaw(fs.readFileSync(this.filePath, "utf8"), key);
    } catch {
      return "prompt";
    }
  }

  private async readContentForWrite(): Promise<FolderTrustFileContent> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8")) as FolderTrustFileContent;
      if (parsed?.version === 1 && typeof parsed.folders === "object" && parsed.folders !== null) return parsed;
    } catch {
      /* absent or corrupt: start clean (corrupt already read as prompt everywhere) */
    }
    return { version: 1, folders: {} };
  }

  public async setLevel(
    folder: string,
    level: TrustLevel,
    opts: { updatedBy?: string } = {},
  ): Promise<{ changed: boolean; narrowed: boolean; epoch: number }> {
    const key = FolderTrustStore.canonicalFolder(folder);
    const previous = await this.getLevel(key);
    const narrowed = TRUST_RANK[level] < TRUST_RANK[previous];
    const write = async () => {
      const content = await this.readContentForWrite();
      content.folders[key] = { level, updatedAt: Date.now(), updatedBy: opts.updatedBy ?? this.updatedBy };
      await atomicWriteJson(this.baseDir, FILE_NAME, content);
    };
    if (narrowed) {
      const epoch = await this.grants.narrowAuthority(write);
      return { changed: true, narrowed: true, epoch };
    }
    return this.grants.underLock(async () => {
      // Re-check under the lock; a concurrent writer may have changed it. Same level: no write.
      const epoch = (await this.grants.read()).epoch;
      if ((await this.getLevel(key)) === level) return { changed: false, narrowed: false, epoch };
      await write();
      return { changed: true, narrowed: false, epoch };
    });
  }
}
