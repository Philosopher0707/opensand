import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ErrorCodes, OspError } from "@opensand/protocol";
import { runCommandOperation } from "@opensand/local-exec-daemon";
import {
  loadTargetsFile,
  resolveTargetConfig,
  type TargetConfig,
} from "@opensand/shared";
import {
  ContainerTargetLauncher,
  SshTargetLauncher,
  TargetClient,
  staticTargetSpawn,
  acquireLocalLock,
  acquireTargetLock,
  applyStaging,
  containerExecArgs,
  fetchToStaging,
  pushWorkspace,
  releaseLocalLock,
  releaseTargetLock,
  removeRemoteMissionDir,
  type ContainerTargetSpec,
  type SshTargetSpec,
  type TargetHelloResult,
  type WorkspaceManifest,
  type ExecCommandInput,
  ExecCommandOutput,
  type ReadFileInput, type ReadFileOutput,
  type WriteFileInput, type WriteFileOutput,
  type EditFileInput, type EditFileOutput,
  type GrepInput, type GrepOutput,
  type GlobInput, type GlobOutput,
  type ListDirectoryInput, type ListDirectoryOutput,
  TargetApplyConflictError,
} from "@opensand/local-exec-daemon";
import { cleanGitEnv } from "./workspace-diff.js";
import type { MissionWorkspace, TargetIdentity, WorkspaceResult } from "./workspace.js";

/**
 * Target workspaces for missions (docs/design/phase8-reach.md §5.2, §5.3, §7).
 *
 * The root stays the local path for trust, log and snapshots; only the target's
 * own paths and commands are translated. A target never writes the local tree:
 * an SSH result arrives through `prepare()` (fetch to staging, pin the tree)
 * and `apply()` (conflict gate, then one apply pass). The container target is a
 * bind mount, so prepare/apply are no-ops and the mount is the apply.
 */

/** Where the `pnpm target:build` bundle lives: explicit arg, env, or the repo's dist/target. */
export function targetBundleDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.OPENSAND_TARGET_BUNDLE) return process.env.OPENSAND_TARGET_BUNDLE;
  // packages/engine/dist/src/missions/target-workspace.js -> <repo>/dist/target
  return fileURLToPath(new URL("../../../../../dist/target", import.meta.url));
}

function bundleVersion(bundleDir: string): string {
  const requireFromBundle = createRequire(path.join(bundleDir, "package.json"));
  return requireFromBundle(path.join(bundleDir, "package.json")).version as string;
}

/** Resolve a named target from targets.json once, before any trust decision. Unknown = InvalidParams. */
export async function resolveTargetForMission(name: string): Promise<TargetConfig> {
  const file = await loadTargetsFile();
  try {
    return resolveTargetConfig(file, name);
  } catch (err) {
    throw new OspError(ErrorCodes.InvalidParams, (err as Error).message);
  }
}

/** Translate one absolute local path under root into a target path; refuse anything else. */
function targetRelPath(root: string, localPath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(localPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the mission workspace: ${localPath}`);
  }
  return [...rel.split(path.sep)].join("/");
}

/** Shared shape of the daemon's file-operation inputs: a local path plus pass-through fields. */
function translateFileInput<T extends { path: string }>(root: string, targetRoot: string, input: T): T {
  const rel = targetRelPath(root, input.path);
  const absTarget = rel === "" ? targetRoot : `${targetRoot.replace(/\/$/, "")}/${rel}`;
  return { ...input, path: absTarget };
}

/** The container target (§5.2): the workspace is bind-mounted at /workspace, so
 * local and remote bytes are the same and prepare/apply are no-ops. `.git` is
 * mounted read-only, so a check that writes git fails — that is the design. */
class ContainerWorkspace implements MissionWorkspace {
  readonly kind = "container" as const;
  private client?: TargetClient;
  private hello?: TargetHelloResult;
  private readonly launcher: ContainerTargetLauncher;
  private readonly version: string;

  constructor(
    readonly root: string,
    private readonly spec: ContainerTargetSpec,
    bundleDir: string
  ) {
    this.launcher = new ContainerTargetLauncher(spec);
    this.version = bundleVersion(bundleDir);
  }

  identity(): TargetIdentity {
    return {
      name: this.spec.targetId,
      kind: "container",
      ...(this.hello?.platform ? { platform: this.hello.platform } : {}),
      ...(this.hello ? { root: this.hello.root } : {}),
    };
  }

  private requireClient(): TargetClient {
    if (!this.client || !this.hello) throw new Error("target link is not connected; begin() first");
    return this.client;
  }

  private targetRoot(): string {
    return this.hello?.root ?? "/workspace";
  }

  async exec(input: ExecCommandInput, _opts?: { signal?: AbortSignal }): Promise<ExecCommandOutput> {
    // The container is the boundary: the local sandbox profile does not cross the link.
    const params = {
      command: input.command,
      ...(input.cwd ? { cwd: translateFileInput(this.root, this.targetRoot(), { path: input.cwd }).path } : {}),
      ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
      ...(input.env ? { env: input.env } : {}),
    };
    return this.requireClient().exec(params) as Promise<ExecCommandOutput>;
  }

  async readFile(input: ReadFileInput): Promise<ReadFileOutput> {
    return this.requireClient().readFile(translateFileInput(this.root, this.targetRoot(), input)) as Promise<ReadFileOutput>;
  }

  async writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
    return this.requireClient().writeFile(translateFileInput(this.root, this.targetRoot(), input)) as Promise<WriteFileOutput>;
  }

  async editFile(input: EditFileInput): Promise<EditFileOutput> {
    return this.requireClient().editFile(translateFileInput(this.root, this.targetRoot(), input)) as Promise<EditFileOutput>;
  }

  async grep(input: GrepInput): Promise<GrepOutput> {
    return this.requireClient().grep(this.translateOptional(input)) as Promise<GrepOutput>;
  }

  async glob(input: GlobInput): Promise<GlobOutput> {
    return this.requireClient().glob(this.translateOptional(input)) as Promise<GlobOutput>;
  }

  async listDirectory(input: ListDirectoryInput): Promise<ListDirectoryOutput> {
    return this.requireClient().listDirectory(translateFileInput(this.root, this.targetRoot(), input)) as Promise<ListDirectoryOutput>;
  }

  private translateOptional<T extends { path?: string }>(input: T): T {
    return input.path === undefined ? input : translateFileInput(this.root, this.targetRoot(), input as T & { path: string });
  }

  async begin(): Promise<void> {
    await this.launcher.preflight();
    const { client, hello } = await this.launcher.start(() =>
      new TargetClient({
        spawn: staticTargetSpawn(this.spec.runtime, containerExecArgs(this.spec)),
        version: this.version,
      })
    );
    this.client = client;
    this.hello = hello;
  }

  async prepare(): Promise<WorkspaceResult> {
    return {};
  }

  async apply(): Promise<WorkspaceResult> {
    return {};
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.hello = undefined;
    await this.launcher.stop();
  }
}

/**
 * The SSH target (§5.3): one push before act, one fetch to staging in prepare,
 * one conflict-gated apply after acceptance. The remote mission dir is kept on
 * every ending — on failure it is the only copy of unapplied work.
 */
class SshTargetWorkspace implements MissionWorkspace {
  readonly kind = "ssh" as const;
  private client?: TargetClient;
  private hello?: TargetHelloResult;
  private readonly launcher: SshTargetLauncher;
  private readonly spec: SshTargetSpec;
  private readonly remoteOpts: { host: string; sshArgs?: string[] };
  private manifest?: WorkspaceManifest;
  private stagingDir?: string;
  private localLockHeld = false;
  private targetLockHeld = false;

  constructor(
    readonly root: string,
    private readonly config: TargetConfig & { kind: "ssh" },
    private readonly name: string,
    private readonly missionId: string,
    bundleDir: string,
    private readonly notify?: (phase: string, detail?: string) => Promise<void>
  ) {
    this.spec = {
      host: config.host,
      root: config.root,
      sshArgs: config.sshArgs,
      missionId,
      targetId: name,
      bundleDir,
      workspaceRoot: root,
      sandbox: config.sandbox ?? "bwrap",
    };
    this.launcher = new SshTargetLauncher(this.spec);
    this.remoteOpts = { host: config.host, sshArgs: config.sshArgs };
  }

  identity(): TargetIdentity {
    return {
      name: this.name,
      kind: "ssh",
      ...(this.hello?.platform ? { platform: this.hello.platform } : {}),
      ...(this.hello ? { root: this.hello.root } : {}),
    };
  }

  private requireClient(): TargetClient {
    if (!this.client || !this.hello) throw new Error("target link is not connected; begin() first");
    return this.client;
  }

  private targetPath(localPath: string): string {
    const rel = targetRelPath(this.root, localPath);
    const remoteRoot = this.hello?.root ?? "";
    return rel === "" ? remoteRoot : `${remoteRoot.replace(/\/$/, "")}/${rel}`;
  }

  async exec(input: ExecCommandInput, _opts?: { signal?: AbortSignal }): Promise<ExecCommandOutput> {
    const params = {
      command: input.command,
      ...(input.cwd ? { cwd: this.targetPath(input.cwd) } : {}),
      ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
      ...(input.env ? { env: input.env } : {}),
    };
    return this.requireClient().exec(params) as Promise<ExecCommandOutput>;
  }

  async readFile(input: ReadFileInput): Promise<ReadFileOutput> {
    return this.requireClient().readFile({ ...input, path: this.targetPath(input.path) }) as Promise<ReadFileOutput>;
  }

  async writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
    return this.requireClient().writeFile({ ...input, path: this.targetPath(input.path) }) as Promise<WriteFileOutput>;
  }

  async editFile(input: EditFileInput): Promise<EditFileOutput> {
    return this.requireClient().editFile({ ...input, path: this.targetPath(input.path) }) as Promise<EditFileOutput>;
  }

  async grep(input: GrepInput): Promise<GrepOutput> {
    return this.requireClient().grep(input.path === undefined ? input : { ...input, path: this.targetPath(input.path) }) as Promise<GrepOutput>;
  }

  async glob(input: GlobInput): Promise<GlobOutput> {
    return this.requireClient().glob(input.path === undefined ? input : { ...input, path: this.targetPath(input.path) }) as Promise<GlobOutput>;
  }

  async listDirectory(input: ListDirectoryInput): Promise<ListDirectoryOutput> {
    return this.requireClient().listDirectory({ ...input, path: this.targetPath(input.path) }) as Promise<ListDirectoryOutput>;
  }

  async begin(): Promise<void> {
    // §4.4: one mission per target root and per local workspace; the second is target-busy.
    acquireLocalLock(this.root, this.missionId);
    this.localLockHeld = true;
    await acquireTargetLock(this.config.root, this.missionId, this.remoteOpts);
    this.targetLockHeld = true;
    await this.launcher.preflight();
    await this.launcher.deploy();
    const { client, hello } = await this.launcher.start(() =>
      new TargetClient({ spawn: this.launcher.makeSpawnFn(), version: bundleVersion(this.spec.bundleDir) })
    );
    this.client = client;
    this.hello = hello;
    this.stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-ssh-stage-"));
    try {
      this.manifest = await pushWorkspace(this.root, this.config.root, this.missionId, this.remoteOpts);
    } catch (err) {
      // §8: a failed push deletes the partial remote dir best-effort; local untouched.
      await removeRemoteMissionDir(this.config.root, this.missionId, this.remoteOpts);
      throw err;
    }
    await this.notify?.("push");
  }

  async prepare(): Promise<WorkspaceResult> {
    await fetchToStaging(this.config.root, this.missionId, this.stagingDir!, this.remoteOpts);
    const tree = await pinStagingTree(this.root, this.stagingDir!);
    if (tree) await pinTargetTree(this.root, this.missionId, tree);
    return { ...(tree ? { tree } : {}) };
  }

  async apply(): Promise<WorkspaceResult> {
    if (!this.stagingDir || !this.manifest) throw new Error("prepare() before apply()");
    const result = await applyStaging(this.stagingDir, this.root, this.manifest);
    return { applied: true, detail: `${result.added.length} added, ${result.replaced.length} replaced, ${result.deleted.length} deleted` };
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.hello = undefined;
    if (this.targetLockHeld) {
      this.targetLockHeld = false;
      await releaseTargetLock(this.config.root, this.missionId, this.remoteOpts).catch(() => undefined);
    }
    if (this.localLockHeld) {
      this.localLockHeld = false;
      releaseLocalLock(this.root, this.missionId);
    }
    if (this.stagingDir) {
      await fs.promises.rm(this.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      this.stagingDir = undefined;
    }
  }
}

/**
 * Pins the fetched staging tree into the local repository with the existing
 * temp-index machinery (§5.3): the tree object lands in the workspace repo, so
 * the review diff and the receipt read a real tree without touching the
 * user's index, branch or stash.
 */
export async function pinStagingTree(workspaceRoot: string, stagingDir: string): Promise<string | undefined> {
  const tmpIndex = path.join(os.tmpdir(), `opensand-git-idx-${randomUUID()}`);
  try {
    const res = await runCommandOperation({
      command: "git add -A && git write-tree",
      cwd: workspaceRoot,
      workspaceRoot,
      env: { ...cleanGitEnv(), GIT_WORK_TREE: path.resolve(stagingDir), GIT_INDEX_FILE: tmpIndex } as any,
    });
    if (res.exitCode !== 0) return undefined;
    const lines = res.stdout.trim().split("\n");
    const tree = lines[lines.length - 1]?.trim();
    return tree || undefined;
  } catch {
    return undefined;
  } finally {
    await fs.promises.rm(tmpIndex, { force: true }).catch(() => undefined);
  }
}

/** Keep the fetched result reachable so a conflict or failure can be inspected. */
async function pinTargetTree(workspaceRoot: string, missionId: string, tree: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId) || missionId.includes("..")) return;
  if (!/^[0-9a-f]{40,64}$/.test(tree)) return;
  try {
    await runCommandOperation({
      command: `git update-ref refs/opensand/missions/${missionId}/target-tree ${tree}`,
      cwd: workspaceRoot,
      workspaceRoot,
      env: cleanGitEnv() as any,
    });
  } catch {
    // best effort: the tree stays in the object database until gc
  }
}

export interface TargetWorkspaceParams {
  missionId: string;
  workspaceRoot: string;
  name: string;
  config: TargetConfig;
  bundleDir?: string;
}

/** Build (not connect) the workspace for a resolved target config. Sync on purpose. */
export function buildTargetWorkspace(
  params: TargetWorkspaceParams,
  notify?: (phase: string, detail?: string) => Promise<void>
): MissionWorkspace {
  const bundleDir = targetBundleDir(params.bundleDir);
  if (params.config.kind === "container") {
    const spec: ContainerTargetSpec = {
      runtime: params.config.runtime ?? "docker",
      image: params.config.image,
      network: params.config.network ?? "none",
      ...(params.config.memory ? { memory: params.config.memory } : {}),
      ...(params.config.cpus ? { cpus: params.config.cpus } : {}),
      missionId: params.missionId,
      targetId: params.name,
      bundleDir,
      workspaceRoot: params.workspaceRoot,
    };
    return new ContainerWorkspace(params.workspaceRoot, spec, bundleDir);
  }
  return new SshTargetWorkspace(
    params.workspaceRoot,
    params.config as TargetConfig & { kind: "ssh" },
    params.name,
    params.missionId,
    bundleDir,
    notify
  );
}

export { TargetApplyConflictError };
