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
import { DaemonState, DaemonConnection, DaemonSupervisorHeartbeat, PermissionGates, DaemonLivenessResult } from "./types.js";
export { DaemonLivenessResult };

export class StateManager {
  private baseDir: string;

  constructor(customDir?: string) {
    this.baseDir = customDir ?? path.join(os.homedir(), ".opensand", "state");
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
    const allowlist = await this.readJsonSafe<{ allowlist: string[] }>("standing-allowlist.json");

    return {
      computerUseAllowed: computerUse?.allowed ?? false,
      deviceToolsAllowed: deviceTools?.allowed ?? false,
      standingAllowlist: allowlist?.allowlist ?? [],
    };
  }

  async writePermissionGates(gates: Partial<PermissionGates>): Promise<void> {
    if (gates.computerUseAllowed !== undefined) {
      await this.writeJsonAtomic("local-computer-use-gate.json", { allowed: gates.computerUseAllowed });
    }
    if (gates.deviceToolsAllowed !== undefined) {
      await this.writeJsonAtomic("local-device-tools-gate.json", { allowed: gates.deviceToolsAllowed });
    }
    if (gates.standingAllowlist !== undefined) {
      await this.writeJsonAtomic("standing-allowlist.json", { allowlist: gates.standingAllowlist });
    }
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.resolvePath("local-exec-daemon.json"), { force: true }).catch(() => {});
    await fs.rm(this.resolvePath("local-exec-daemon-connection.json"), { force: true }).catch(() => {});
  }
}
