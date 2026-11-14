import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GrantsStore, legacyPatternsToGrants } from "@opensand/shared";

export const LEGACY_ALLOWLIST_FILE = "standing-allowlist.json";

export interface LegacyMigrationResult {
  /** none: no legacy file. migrated: imported and renamed aside. archived: renamed aside without importing (a revoke has happened). corrupt: unreadable, renamed aside. */
  status: "none" | "migrated" | "archived" | "corrupt";
  imported?: number;
  skippedExisting?: number;
  skipped?: Array<{ pattern: unknown; reason: string }>;
}

export interface LegacyMigrationHooks {
  /** Test seam: runs after the import was persisted and before the rename (a crash window). */
  afterImport?: () => void | Promise<void>;
}

function setAside(file: string, marker: "migrated" | "corrupt"): Promise<void> {
  const suffix = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  return fs.rename(file, `${file}.${marker}-${suffix}`).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/**
 * One-time move of `<stateDir>/standing-allowlist.json` onto grants.json. The only code that
 * reads the legacy file. Never deletes it: it is renamed to `.migrated-*` or `.corrupt-*`.
 *
 * - Idempotent: patterns become `always` exec_command grants through `GrantsStore.importGrants`,
 *   which skips scopes that already exist, so re-running after a crash between import and rename adds nothing.
 * - Failure never grants: a throw (corrupt grants.json, lock timeout, ...) leaves the legacy file where it is.
 * - A revoke is never undone: once the epoch is above 1, some grant has been revoked and the legacy
 *   file cannot say which, so it is archived without importing. The user re-approves what they still want.
 * - Importing adds authority, so it does not bump the epoch.
 */
export async function migrateLegacyAllowlist(
  grants: GrantsStore,
  stateDir: string,
  hooks: LegacyMigrationHooks = {},
): Promise<LegacyMigrationResult> {
  const file = path.join(stateDir, LEGACY_ALLOWLIST_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { status: "none" };
    throw err;
  }

  let patterns: unknown;
  try {
    const parsed = JSON.parse(text);
    patterns = parsed !== null && typeof parsed === "object" ? (parsed as { allowlist?: unknown }).allowlist : undefined;
  } catch {
    patterns = undefined;
  }
  if (!Array.isArray(patterns)) {
    await setAside(file, "corrupt");
    return { status: "corrupt" };
  }

  if ((await grants.read()).epoch > 1) {
    await setAside(file, "migrated");
    return { status: "archived" };
  }

  const { grants: toImport, skipped } = legacyPatternsToGrants(patterns);
  const { added, skippedExisting } = await grants.importGrants(toImport);
  await hooks.afterImport?.();
  await setAside(file, "migrated");
  return { status: "migrated", imported: added.length, skippedExisting, skipped };
}
