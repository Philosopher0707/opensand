import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TargetErrorCodes, TargetLinkError } from "./types.js";
import {
  buildManifest, readManifest, writeManifest, localEntryState, sha256File, shq,
  type WorkspaceManifest, type ManifestEntry,
} from "./manifest.js";

/**
 * Workspace sync for SSH targets (docs/design/phase8-reach.md §4.3, §5.3, §5.4,
 * §8) plus the deploy-by-content-hash of the target bundle and the target /
 * workspace locks (§4.4).
 *
 * Every remote access goes through an argument array: `rsync` and `ssh` are
 * never given a shell string to interpolate a path into. With no host set the
 * "remote" is the local filesystem (that is exactly what the tests use as a
 * temp remote, and it keeps one code path for both). Never a password prompt:
 * ssh runs with `BatchMode=yes` and the user's own config/agent.
 */

export interface SyncRemoteOptions {
  /** SSH host; omitted means the local filesystem (tests). */
  host?: string;
  /** Extra ssh arguments from targets.json, passed before our BatchMode. */
  sshArgs?: string[];
}

export interface RemoteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run one POSIX shell command on the remote. Local mode runs /bin/sh directly. */
export async function remoteExec(command: string, opts: SyncRemoteOptions = {}, timeoutMs = 120_000): Promise<RemoteExecResult> {
  const args = opts.host
    ? [...(opts.sshArgs ?? []), "-o", "BatchMode=yes", opts.host, command]
    : ["-c", command];
  return new Promise((resolve, reject) => {
    execFile(opts.host ? "ssh" : "/bin/sh", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number") {
        // execFile sets err.code to the exit code for a non-zero exit.
        resolve({ exitCode: (err as { code: number }).code, stdout: String(stdout), stderr: String(stderr) });
      } else if (err) {
        err.message = `${opts.host ? "ssh" : "sh"} failed: ${err.message}${stderr ? `\n${stderr.trim()}` : ""}`;
        reject(err);
      } else {
        resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

export class TargetSyncError extends Error {
  public readonly reason: string;

  constructor(reason: string, message: string) {
    super(`${reason}: ${message}`);
    this.name = "TargetSyncError";
    this.reason = reason;
  }
}

/** Second holder of the target or the local workspace lock (§4.4). */
export class TargetBusyError extends TargetLinkError {
  constructor(message: string) {
    super(TargetErrorCodes.Busy, message);
    this.name = "TargetBusyError";
  }
}

export class TargetApplyConflictError extends TargetSyncError {
  public readonly paths: string[];

  constructor(paths: string[]) {
    const shown = paths.slice(0, 5).join(", ");
    super("target-apply-conflict", `local workspace changed since push: ${shown}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}`);
    this.paths = paths;
  }
}

/** Remote path spec for rsync: `host:path` over ssh, plain path locally. */
function remoteSpec(host: string | undefined, remotePath: string): string {
  return host ? `${host}:${remotePath}` : remotePath;
}

/** rsync's remote paths are POSIX (Linux host); local temp dirs are POSIX too. */
function remoteJoin(...parts: string[]): string {
  return path.posix.join(...parts);
}

// ---------------------------------------------------------------------------
// Bundle deploy by content hash (§4.3)
// ---------------------------------------------------------------------------

/**
 * sha256 over the bundle's sorted (relative path, type, mode, content) tuples.
 * Two builds of the same bundle hash the same, so the remote deploy directory
 * is keyed by content: an unchanged bundle reuses its dir, an upgrade lands in
 * a new one and the old dir is simply abandoned.
 */
export async function bundleHash(bundleDir: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const dirent of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relChild = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) {
        digest.update(`l ${relChild} ${await fsp.readlink(path.join(dir, dirent.name))}\n`);
      } else if (dirent.isDirectory()) {
        digest.update(`d ${relChild}\n`);
        await walk(path.join(dir, dirent.name), relChild);
      } else if (dirent.isFile()) {
        const stat = await fsp.stat(path.join(dir, dirent.name));
        const fileHash = await sha256File(path.join(dir, dirent.name));
        digest.update(`f ${relChild} ${stat.mode & 0o777} ${fileHash}\n`);
      }
    }
  };
  await walk(bundleDir, "");
  return digest.digest("hex").slice(0, 32);
}

/** The deployed dir for one bundle hash: `<root>/.opensand/target/<hash>`. */
export function deployedBundleDir(remoteRoot: string, hash: string): string {
  return remoteJoin(remoteRoot, ".opensand", "target", hash);
}

/**
 * Deploy the local bundle to the remote, keyed by its content hash, before any
 * push (§4.3). Idempotent: the entry file's presence skips the rsync; an
 * interrupted earlier rsync is repaired by running again. A failed deploy
 * leaves nothing local touched — this function only writes the remote.
 */
export async function deployBundle(
  bundleDir: string,
  remoteRoot: string,
  opts: SyncRemoteOptions = {},
): Promise<string> {
  const hash = await bundleHash(bundleDir);
  const dest = deployedBundleDir(remoteRoot, hash);
  const entry = remoteJoin(dest, "dist", "src", "target", "bin.js");
  const check = await remoteExec(`test -f ${shq(entry)} && echo ok`, opts);
  if (check.exitCode !== 0 || check.stdout.trim() !== "ok") {
    // rsync creates the destination's final component only; its parents must
    // exist first (Linux rsync fails with ENOENT, unlike macOS's).
    await remoteExec(`mkdir -p ${shq(dest)}`, opts);
    await new Promise<void>((resolve, reject) => {
      execFile(
        "rsync",
        ["-a", `${path.resolve(bundleDir)}/`, remoteSpec(opts.host, `${dest}/`)],
        { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            err.message = `rsync deploy failed: ${err.message}${stderr ? `\n${String(stderr).trim()}` : ""}`;
            reject(err);
          } else resolve();
        },
      );
    });
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Push, fetch, apply (§5.3)
// ---------------------------------------------------------------------------

export function missionRemoteDir(remoteRoot: string, missionId: string): string {
  return remoteJoin(remoteRoot, "missions", missionId);
}

function defaultManifestPath(missionId: string): string {
  const home = process.env.OPENSAND_HOME || path.join(process.env.HOME || "", ".opensand");
  return path.join(home, "missions", missionId, "target-manifest.json");
}

/**
 * Push the local workspace to the mission dir: build the manifest first (a
 * symlink escape or an oversized tree refuses before anything moves), write it,
 * then `rsync -a --delete --exclude .git`. `.git` never reaches the target —
 * no hooks, no refs, nothing the agent could turn into code execution on the
 * user's next commit.
 */
export async function pushWorkspace(
  workspaceRoot: string,
  remoteRoot: string,
  missionId: string,
  opts: SyncRemoteOptions & { manifestPath?: string } = {},
): Promise<WorkspaceManifest> {
  const { host, sshArgs, manifestPath = defaultManifestPath(missionId) } = opts;
  const manifest = await buildManifest(workspaceRoot);
  await writeManifest(manifestPath, manifest);
  const destDir = missionRemoteDir(remoteRoot, missionId);
  // rsync creates the destination's final component only; its parents must
  // exist first (Linux rsync fails with ENOENT, unlike macOS's).
  await remoteExec(`mkdir -p ${shq(destDir)}`, { host, sshArgs });
  const dest = remoteSpec(host, `${destDir}/`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "rsync",
      ["-a", "--delete", "--exclude", ".git", `${path.resolve(workspaceRoot)}/`, dest],
      { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          err.message = `target-push-failed: rsync push failed: ${err.message}${stderr ? `\n${String(stderr).trim()}` : ""}`;
          reject(err);
        } else resolve();
      },
    );
  });
  return manifest;
}

/** Best-effort `ssh rm -rf` of a partial mission dir after a failed push (§8). */
export async function removeRemoteMissionDir(remoteRoot: string, missionId: string, opts: SyncRemoteOptions = {}): Promise<void> {
  await remoteExec(`rm -rf ${shq(missionRemoteDir(remoteRoot, missionId))}`, opts).catch(() => undefined);
}

/**
 * Fetch the remote mission dir into a staging directory. Nothing local beyond
 * the staging dir is written; a failed check can be repaired remotely while
 * staging is discarded and refetched.
 */
export async function fetchToStaging(
  remoteRoot: string,
  missionId: string,
  stagingDir: string,
  opts: SyncRemoteOptions = {},
): Promise<void> {
  const { host, sshArgs } = opts;
  await fsp.mkdir(stagingDir, { recursive: true });
  const src = remoteSpec(host, `${missionRemoteDir(remoteRoot, missionId)}/`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "rsync",
      ["-a", "--delete", src, `${path.resolve(stagingDir)}/`],
      { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          err.message = `target-apply-failed: rsync fetch failed: ${err.message}${stderr ? `\n${String(stderr).trim()}` : ""}`;
          reject(err);
        } else resolve();
      },
    );
  });
}

export interface ApplyResult {
  added: string[];
  replaced: string[];
  deleted: string[];
}

/**
 * Apply the staging tree into the local workspace, only after review accepted
 * (§5.3 apply). Compare every add/replace/delete against the push manifest:
 * - local hash equals the manifest hash → safe to replace or delete;
 * - local file absent and the manifest has it → safe to delete;
 * - anything else (a user edit, a new local file) → conflict, and the local
 *   workspace is not touched at all.
 * Applies in one pass: temp files are written and renamed, modes preserved,
 * deletes unlink only manifest paths.
 */
export async function applyStaging(
  stagingDir: string,
  workspaceRoot: string,
  manifest: WorkspaceManifest,
): Promise<ApplyResult> {
  const stagingManifest = await buildManifest(stagingDir);

  const conflicts: string[] = [];
  const adds: string[] = [];
  const replaces: string[] = [];
  const deletes: string[] = [];

  for (const rel of Object.keys(stagingManifest.entries)) {
    const stagingEntry = stagingManifest.entries[rel];
    const manifestEntry: ManifestEntry | undefined = manifest.entries[rel];
    const local = await localEntryState(workspaceRoot, rel);
    const localMissing = local.missing;
    if (!manifestEntry) {
      // Remote-created file: safe only where the user has not created the same
      // path locally after the push.
      if (!localMissing) conflicts.push(rel);
      else adds.push(rel);
      continue;
    }
    const localSameAsManifest =
      !localMissing &&
      local.hash === manifestEntry.hash &&
      local.symlink === manifestEntry.symlink;
    if (!localSameAsManifest) {
      conflicts.push(rel);
      continue;
    }
    if (stagingEntry.hash !== manifestEntry.hash || stagingEntry.symlink !== manifestEntry.symlink) {
      replaces.push(rel);
    }
  }
  for (const rel of Object.keys(manifest.entries)) {
    if (stagingManifest.entries[rel] !== undefined) continue;
    const local = await localEntryState(workspaceRoot, rel);
    const localMissing = local.missing;
    const localSameAsManifest =
      !localMissing &&
      local.hash === manifest.entries[rel].hash &&
      local.symlink === manifest.entries[rel].symlink;
    if (localMissing || localSameAsManifest) deletes.push(rel);
    else conflicts.push(rel);
  }
  if (conflicts.length > 0) throw new TargetApplyConflictError(conflicts.sort());

  // All temp writes first, then renames, then deletes: a failure before the
  // renames leaves the local tree byte-identical.
  const staged: Array<{ abs: string; tmp: string; mode: number | null; symlink?: string }> = [];
  try {
    for (const rel of [...adds, ...replaces]) {
      const stagingAbs = path.join(stagingDir, ...rel.split("/"));
      const localAbs = path.join(workspaceRoot, ...rel.split("/"));
      await fsp.mkdir(path.dirname(localAbs), { recursive: true });
      const entry = stagingManifest.entries[rel];
      if (entry.symlink !== undefined) {
        staged.push({ abs: localAbs, tmp: localAbs, mode: null, symlink: entry.symlink });
        continue;
      }
      const tmp = `${localAbs}.opensand-apply-${process.pid}-${staged.length}`;
      const stat = await fsp.stat(stagingAbs);
      await fsp.copyFile(stagingAbs, tmp);
      await fsp.chmod(tmp, stat.mode & 0o7777);
      staged.push({ abs: localAbs, tmp, mode: stat.mode & 0o7777 });
    }
    for (const item of staged) {
      if (item.symlink !== undefined) {
        await fsp.rm(item.abs, { force: true, recursive: false });
        await fsp.symlink(item.symlink, item.abs);
      } else {
        await fsp.rename(item.tmp, item.abs);
      }
    }
  } catch (err) {
    for (const item of staged) await fsp.rm(item.tmp, { force: true }).catch(() => undefined);
    throw new TargetSyncError(
      "target-apply-failed",
      `staging could not be copied into the workspace: ${(err as Error).message}`,
    );
  }
  for (const rel of deletes) {
    await fsp.rm(path.join(workspaceRoot, ...rel.split("/")), { force: true, recursive: false }).catch(() => undefined);
  }
  return { added: adds.sort(), replaced: replaces.sort(), deleted: deletes.sort() };
}

// ---------------------------------------------------------------------------
// Locks (§4.4)
// ---------------------------------------------------------------------------

export interface LockHolder {
  missionId: string;
  /** Epoch ms after which the lock is stale and may be taken over. */
  staleAfter: number;
}

export const TARGET_LOCK_DIR = ".opensand/lock";

/**
 * Target lock at `<root>/.opensand/lock`, claimed with an atomic remote
 * `mkdir` (POSIX, no shell features needed). Records the mission id and a
 * stale-after timestamp; a second mission gets `target-busy`, and a stale
 * holder may be taken over.
 */
export async function acquireTargetLock(
  remoteRoot: string,
  missionId: string,
  opts: SyncRemoteOptions & { staleAfterMs?: number; now?: number } = {},
): Promise<LockHolder> {
  const staleAfterMs = opts.staleAfterMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now();
  const lockDir = remoteJoin(remoteRoot, TARGET_LOCK_DIR);
  const holderPath = remoteJoin(lockDir, "holder");
  for (let attempt = 0; attempt < 2; attempt++) {
    const holder = JSON.stringify({ missionId, staleAfter: now + staleAfterMs } satisfies LockHolder);
    const claim = `mkdir -p ${shq(path.dirname(lockDir))} 2>/dev/null; if mkdir ${shq(lockDir)} 2>/dev/null; then printf '%s' ${shq(holder)} > ${shq(holderPath)}; echo claimed; else cat ${shq(holderPath)} 2>/dev/null || echo '{"missionId":"unknown","staleAfter":0}'; exit 3; fi`;
    const result = await remoteExec(claim, opts);
    if (result.exitCode === 0 && result.stdout.trim().startsWith("claimed")) {
      return { missionId, staleAfter: now + staleAfterMs };
    }
    if (result.exitCode !== 3) {
      throw new TargetSyncError("target-lock-failed", `could not read the lock at ${lockDir}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
    }
    let holderInfo: LockHolder;
    try {
      holderInfo = JSON.parse(result.stdout.trim()) as LockHolder;
    } catch {
      throw new TargetBusyError(`target-busy: the target lock at ${lockDir} has an unreadable holder`);
    }
    if (holderInfo.staleAfter > now) {
      throw new TargetBusyError(`target-busy: held by mission ${holderInfo.missionId}`);
    }
    // Stale: drop it and race the mkdir again; whoever wins mkdir holds it.
    if (attempt === 0) {
      await remoteExec(`rm -rf ${shq(lockDir)}`, opts);
      continue;
    }
    throw new TargetBusyError(`target-busy: held by mission ${holderInfo.missionId}`);
  }
  throw new TargetBusyError(`target-busy: held by another mission`);
}

/** Release the target lock when this mission still holds it. */
export async function releaseTargetLock(
  remoteRoot: string,
  missionId: string,
  opts: SyncRemoteOptions = {},
): Promise<void> {
  const lockDir = remoteJoin(remoteRoot, TARGET_LOCK_DIR);
  const holderPath = remoteJoin(lockDir, "holder");
  const result = await remoteExec(`cat ${shq(holderPath)} 2>/dev/null`, opts);
  try {
    const holder = JSON.parse(result.stdout.trim()) as LockHolder;
    if (holder.missionId === missionId) {
      await remoteExec(`rm -rf ${shq(lockDir)}`, opts);
    }
  } catch {
    // Not ours or unreadable: leave it alone.
  }
}

/** In-process locks on the local workspace, keyed by the resolved root. */
const localLocks = new Map<string, LockHolder>();

/** Local workspace lock: a second mission on the same workspace is `target-busy`. */
export function acquireLocalLock(
  workspaceRoot: string,
  missionId: string,
  opts: { staleAfterMs?: number; now?: number } = {},
): LockHolder {
  const staleAfterMs = opts.staleAfterMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now();
  const key = path.resolve(workspaceRoot);
  const existing = localLocks.get(key);
  if (existing && existing.staleAfter > now && existing.missionId !== missionId) {
    throw new TargetBusyError(`target-busy: local workspace ${key} is held by mission ${existing.missionId}`);
  }
  const holder = { missionId, staleAfter: now + staleAfterMs };
  localLocks.set(key, holder);
  return holder;
}

/** Release the local workspace lock when this mission still holds it. */
export function releaseLocalLock(workspaceRoot: string, missionId: string): void {
  const key = path.resolve(workspaceRoot);
  const existing = localLocks.get(key);
  if (existing?.missionId === missionId) localLocks.delete(key);
}

/** Manifest read helper for the apply caller (it must pass the pushed manifest). */
export { readManifest };
