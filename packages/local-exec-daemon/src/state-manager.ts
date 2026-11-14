/**
 * Test whether a given PID corresponds to an active running process.
 * Guards against non-integers, zero, and negative PIDs.
 * Uses process.kill(pid, 0) without delivering a fatal signal:
 * - ESRCH -> false (process does not exist)
 * - EPERM -> true (process exists but belongs to another user)
 * - fallback -> false
 */
export function isPidAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === "ESRCH") {
      return false;
    }
    if (err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { GrantsStore, standingExecPatterns } from "@opensand/shared";
import type { CapabilityGrant } from "@opensand/shared";
import { migrateLegacyAllowlist } from "./legacy-allowlist-migration.js";
import { DaemonState, DaemonConnection, DaemonSupervisorHeartbeat, PermissionGates, DaemonLivenessResult } from "./types.js";
export { DaemonLivenessResult };

export class StateManager {
  private baseDir: string;
  private readonly grants: GrantsStore;
  private migration: Promise<void> | null = null;
  private warnedLegacyWrite = false;

  /**
   * `grants` defaults to the store beside the state dir (`<base>/state` -> `<base>/grants.json`),
   * or to the shared default (`$OPENSAND_STATE_DIR`, else `~/.opensand`) when no dir is given.
   */
  constructor(customDir?: string, grants?: GrantsStore) {
    this.baseDir = customDir ?? path.join(os.homedir(), ".opensand", "state");
    this.grants = grants ?? new GrantsStore(
      customDir ? { baseDir: path.dirname(customDir), updatedBy: "daemon:local-exec" } : { updatedBy: "daemon:local-exec" },
    );
  }

  get grantsStore(): GrantsStore {
    return this.grants;
  }

  get stateDirectory(): string {
    return this.baseDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private resolvePath(filename: string): string {
    return path.join(this.baseDir, filename);
  }

  private async writeJsonAtomic(filename: string, data: any): Promise<void> {
    await this.ensureDirectory();
    const targetPath = this.resolvePath(filename);
    const tempPath = path.join(this.baseDir, `.${filename}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    const content = JSON.stringify(data, null, 2);

    try {
      await fs.writeFile(tempPath, content, { mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async readJsonSafe<T>(filename: string): Promise<T | null> {
    try {
      const targetPath = this.resolvePath(filename);
      const text = await fs.readFile(targetPath, "utf-8");
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  // --- Daemon Liveness (daemon.json) ---
  async writeDaemonState(state: DaemonState): Promise<void> {
    await this.writeJsonAtomic("local-exec-daemon.json", state);
  }

  async readDaemonState(): Promise<DaemonState | null> {
    return this.readJsonSafe<DaemonState>("local-exec-daemon.json");
  }

  isPidAlive(pid: number): boolean {
    return isPidAlive(pid);
  }

  async isDaemonRunning(): Promise<DaemonLivenessResult> {
    const state = await this.readDaemonState();
    if (!state || typeof state.pid !== "number" || !Number.isInteger(state.pid) || state.pid <= 0) {
      return { running: false, stale: false };
    }

    const alive = isPidAlive(state.pid);
    if (!alive) {
      return {
        running: false,
        pid: state.pid,
        generation: state.generation,
        stale: true,
      };
    }

    return {
      running: true,
      pid: state.pid,
      generation: state.generation,
      stale: false,
    };
  }


  // --- Connection & Endpoints (connection.json) ---
  async writeConnection(connection: DaemonConnection): Promise<void> {
    await this.writeJsonAtomic("local-exec-daemon-connection.json", connection);
  }

  async readConnection(): Promise<DaemonConnection | null> {
    return this.readJsonSafe<DaemonConnection>("local-exec-daemon-connection.json");
  }

  // --- Supervisor Watchdog (supervisor.json) ---
  async writeSupervisorHeartbeat(heartbeat: DaemonSupervisorHeartbeat): Promise<void> {
    await this.writeJsonAtomic("local-exec-supervisor.json", heartbeat);
  }

  async readSupervisorHeartbeat(): Promise<DaemonSupervisorHeartbeat | null> {
    return this.readJsonSafe<DaemonSupervisorHeartbeat>("local-exec-supervisor.json");
  }

  // --- Gates & Permission Policies ---
  async readPermissionGates(): Promise<PermissionGates> {
    const computerUse = await this.readJsonSafe<{ allowed: boolean }>("local-computer-use-gate.json");
    const deviceTools = await this.readJsonSafe<{ allowed: boolean }>("local-device-tools-gate.json");
    const standing = await this.readStandingGrants();

    return {
      computerUseAllowed: computerUse?.allowed ?? false,
      deviceToolsAllowed: deviceTools?.allowed ?? false,
      standingAllowlist: standingExecPatterns(standing.standingGrants),
      ...standing,
    };
  }

  /**
   * One lock-free snapshot of grants.json. Missing file: no grants, not an error. Anything else
   * that stops it being read whole (corrupt, wrong version, EACCES, EIO): no grants, `grantsError`,
   * epoch -1. The file is never repaired or overwritten here.
   */
  private async readStandingGrants(): Promise<Pick<PermissionGates, "standingGrants" | "grantsEpoch" | "grantsError">> {
    await this.ensureMigrated();
    try {
      const content = await this.grants.read();
      const standingGrants = content.grants.filter(
        (g: CapabilityGrant) => g.tool === "exec_command" && g.lifetime === "always",
      );
      return { standingGrants, grantsEpoch: content.epoch };
    } catch {
      return { standingGrants: [], grantsEpoch: -1, grantsError: true };
    }
  }

  /** Runs the legacy standing-allowlist.json migration once per instance; a failure is retried on the next read and never grants. */
  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = migrateLegacyAllowlist(this.grants, this.baseDir).then(
        () => undefined,
        (err) => {
          this.migration = null;
          process.stderr.write(`[local-exec-daemon] standing-allowlist.json migration failed, legacy entries stay denied: ${err?.message ?? err}\n`);
        },
      );
    }
    return this.migration;
  }

  async writePermissionGates(gates: Partial<PermissionGates>): Promise<void> {
    if (gates.computerUseAllowed !== undefined) {
      await this.writeJsonAtomic("local-computer-use-gate.json", { allowed: gates.computerUseAllowed });
    }
    if (gates.deviceToolsAllowed !== undefined) {
      await this.writeJsonAtomic("local-device-tools-gate.json", { allowed: gates.deviceToolsAllowed });
    }
    if (gates.standingAllowlist !== undefined && !this.warnedLegacyWrite) {
      // standingAllowlist is a derived view of grants.json. Narrow or widen it with GrantsStore
      // (revokeGrant, narrowAuthority, addGrant); a bare rewrite would skip the epoch bump.
      this.warnedLegacyWrite = true;
      process.stderr.write("[local-exec-daemon] ignoring write to standingAllowlist: standing permission now lives in grants.json\n");
    }
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.resolvePath("local-exec-daemon.json"), { force: true }).catch(() => {});
    await fs.rm(this.resolvePath("local-exec-daemon-connection.json"), { force: true }).catch(() => {});
  }
}
