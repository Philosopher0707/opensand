import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { isPidAlive } from "@opensand/shared";

const execAsync = promisify(execFile);

export interface AttemptLease {
  pid: number;
  /** Start time of the owning process (epoch ms), not the lease write time. */
  startedAt: number;
  bootId: string;
}

/** Two process-start readings may differ by a couple of seconds (ps granularity). */
const START_TOLERANCE_MS = 10_000;

export function leasePath(attemptsRoot: string, n: number | string): string {
  return `${attemptsRoot}/${n}.lease.json`;
}

let cachedBootId: string | null = null;

async function readBootId(): Promise<string> {
  if (cachedBootId !== null) return cachedBootId;
  try {
    if (process.platform === "linux") {
      const raw = await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8");
      cachedBootId = raw.trim();
    } else {
      const { stdout } = await execAsync("sysctl", ["-n", "kern.boottime"]);
      cachedBootId = stdout.trim();
    }
  } catch {
    cachedBootId = `${os.hostname()}`;
  }
  return cachedBootId;
}

/** Process start time (epoch ms) via ps, or null when the process is gone. */
export async function getProcessStart(pid: number): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const { stdout } = await execAsync("ps", ["-o", "etimes=", "-p", String(pid)]);
      const elapsedSec = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return null;
      return Date.now() - elapsedSec * 1000;
    }
    // macOS: lstart is "Wed Nov 19 07:12:34 2026" in the C locale.
    const { stdout } = await execAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
    });
    const parts = stdout.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months.indexOf(parts[1]);
    const [hh, mm, ss] = parts[3].split(":").map((v) => Number.parseInt(v, 10));
    const year = Number.parseInt(parts[4], 10);
    const day = Number.parseInt(parts[2], 10);
    if (month < 0 || [hh, mm, ss, year, day].some((v) => !Number.isFinite(v))) return null;
    return new Date(year, month, day, hh, mm, ss).getTime();
  } catch {
    return null;
  }
}

/**
 * Write the lease for attempt n. Unlike the design sketch we keep it next to
 * the worktree (<root>/<n>.lease.json), not inside it: a file inside the tree
 * would make every attempt permanently dirty and pollute its snapshot.
 */
export async function writeLease(attemptsRoot: string, n: number | string): Promise<void> {
  const lease: AttemptLease = {
    pid: process.pid,
    startedAt: (await getProcessStart(process.pid)) ?? Date.now(),
    bootId: await readBootId(),
  };
  await fs.writeFile(leasePath(attemptsRoot, n), JSON.stringify(lease), "utf8");
}

/** Rewrite the lease as if its owner died long ago; used by tests and stale marking. */
export async function staleLease(attemptsRoot: string, n: number | string): Promise<void> {
  const lease: AttemptLease = {
    pid: 999999999,
    startedAt: 0,
    bootId: "stale",
  };
  await fs.writeFile(leasePath(attemptsRoot, n), JSON.stringify(lease), "utf8");
}

export async function readLease(attemptsRoot: string, n: number | string): Promise<AttemptLease | null> {
  try {
    const raw = await fs.readFile(leasePath(attemptsRoot, n), "utf8");
    const parsed = JSON.parse(raw) as Partial<AttemptLease>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number" || typeof parsed.bootId !== "string") {
      return null;
    }
    return parsed as AttemptLease;
  } catch {
    return null;
  }
}

export async function removeLease(attemptsRoot: string, n: number | string): Promise<void> {
  await fs.rm(leasePath(attemptsRoot, n), { force: true });
}

/** Live = the recorded pid is alive, on this boot, and started when the lease says it did. */
export async function isLeaseLive(lease: AttemptLease): Promise<boolean> {
  if (!isPidAlive(lease.pid)) return false;
  if (lease.bootId !== (await readBootId())) return false;
  const start = await getProcessStart(lease.pid);
  if (start === null) return false;
  return Math.abs(start - lease.startedAt) <= START_TOLERANCE_MS;
}
