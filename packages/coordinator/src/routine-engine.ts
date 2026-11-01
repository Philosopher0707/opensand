import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { VaultStore } from "./vault-store.js";

/**
 * Clean-room parity with Grok Bot's GrokBotAgentRoutine & GrokBotAgentAutomation:
 * - ListGrokBotAgentRoutines
 * - SetGrokBotAgentRoutineEnabled
 * - TriggerGrokBotAgentRoutine
 * - DeleteGrokBotAgentAutomation
 */

export interface RoutineSchedule {
  type: "interval" | "cron";
  intervalMinutes?: number;
  cron?: string;
  timeZone?: string;
}

export interface AgentRoutine {
  routineId: string;
  automationId: string;
  agentId: string;
  name: string;
  triggerDescription: string;
  triggerPresentationJson: string; // JSON encoded RoutineSchedule
  schedule: string;
  isEnabled: boolean;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  runAsDisplayName: string;
  recordJson: string; // JSON with { prompt: string, allowedTools?: string[], timeoutSeconds?: number }
  lastRunStatus?: "success" | "error" | "running";
  lastRunResult?: string;
  runCount: number;
}

export interface CreateRoutineInput {
  agentId?: string;
  name: string;
  prompt: string;
  scheduleType: "interval" | "cron";
  intervalMinutes?: number;
  cron?: string;
  runAsDisplayName?: string;
  allowedTools?: string[];
  isEnabled?: boolean;
}

export interface RoutineExecutionLog {
  logId: string;
  routineId: string;
  routineName: string;
  startedAtMs: number;
  completedAtMs: number;
  status: "success" | "error";
  result: string;
  error?: string;
}

export type RoutineExecutor = (routine: AgentRoutine) => Promise<{
  result: string;
  status: "success" | "error";
  error?: string;
}>;

/**
 * Pure standard 5-part cron parser and matcher (minute hour dom month dow).
 * Zero external dependencies.
 */
export function matchesCronField(field: string, value: number, minVal: number, maxVal: number): boolean {
  if (field === "*") return true;

  // Step notation: */n or a-b/n
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step > 0 && (value - minVal) % step === 0;
  }

  // Comma-separated list: 1,2,5
  if (field.includes(",")) {
    return field.split(",").some((part) => matchesCronField(part.trim(), value, minVal, maxVal));
  }

  // Range notation: 1-5 or 1-5/2
  if (field.includes("-")) {
    const [rangePart, stepPart] = field.split("/");
    const [startStr, endStr] = rangePart.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (isNaN(start) || isNaN(end) || isNaN(step) || step <= 0) return false;
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  }

  // Exact number
  const num = parseInt(field, 10);
  return !isNaN(num) && num === value;
}

export function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPart, hourPart, domPart, monthPart, dowPart] = parts;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dow = date.getDay(); // 0 (Sun) - 6 (Sat)

  if (!matchesCronField(minPart, minute, 0, 59)) return false;
  if (!matchesCronField(hourPart, hour, 0, 23)) return false;
  if (!matchesCronField(domPart, dom, 1, 31)) return false;
  if (!matchesCronField(monthPart, month, 1, 12)) return false;

  // Sunday can be 0 or 7 in cron
  const dowMatch = matchesCronField(dowPart, dow, 0, 6) || (dow === 0 && matchesCronField(dowPart, 7, 1, 7));
  if (!dowMatch) return false;

  return true;
}

export function computeNextRunAtMs(schedule: RoutineSchedule, fromDate = new Date()): number {
  if (schedule.type === "interval") {
    const intervalMinutes = Math.max(1, schedule.intervalMinutes ?? 60);
    return fromDate.getTime() + intervalMinutes * 60 * 1000;
  }

  if (schedule.type === "cron" && schedule.cron) {
    // Step forward minute by minute, aligned to the next minute
    const test = new Date(fromDate.getTime());
    test.setSeconds(0, 0);
    test.setMinutes(test.getMinutes() + 1);

    // Look up to 366 days ahead (527040 minutes)
    for (let i = 0; i < 527040; i++) {
      if (matchesCron(schedule.cron, test)) {
        return test.getTime();
      }
      test.setMinutes(test.getMinutes() + 1);
    }
  }

  // Fallback: 1 hour from now
  return fromDate.getTime() + 60 * 60 * 1000;
}

export class RoutineEngine {
  private baseDir: string;
  private vaultStore?: VaultStore;
  private executor?: RoutineExecutor;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(customDir?: string, vaultStore?: VaultStore, executor?: RoutineExecutor) {
    this.baseDir = customDir ?? path.join(os.homedir(), ".opensand", "routines");
    this.vaultStore = vaultStore;
    this.executor = executor;
  }

  get storageDirectory(): string {
    return this.baseDir;
  }

  get logsDirectory(): string {
    return path.join(this.baseDir, "logs");
  }

  setExecutor(executor: RoutineExecutor): void {
    this.executor = executor;
  }

  async ensureDirectories(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.logsDirectory, { recursive: true, mode: 0o700 });
  }

  private routineFilePath(routineId: string): string {
    const safeId = routineId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.baseDir, `${safeId}.json`);
  }

  private logFilePath(routineId: string): string {
    const safeId = routineId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.logsDirectory, `${safeId}.jsonl`);
  }

  /**
   * Create a new scheduled routine
   */
  async createRoutine(input: CreateRoutineInput): Promise<AgentRoutine> {
    await this.ensureDirectories();

    const routineId = `routine_${crypto.randomBytes(6).toString("hex")}`;
    const automationId = `auto_${crypto.randomBytes(6).toString("hex")}`;
    const now = Date.now();

    const schedule: RoutineSchedule = {
      type: input.scheduleType,
      intervalMinutes: input.intervalMinutes ?? (input.scheduleType === "interval" ? 60 : undefined),
      cron: input.cron,
    };

    const triggerDescription =
      input.scheduleType === "cron" && input.cron
        ? `Cron: ${input.cron}`
        : `Every ${schedule.intervalMinutes ?? 60} minutes`;

    const isEnabled = input.isEnabled ?? true;
    const nextRunAtMs = isEnabled ? computeNextRunAtMs(schedule, new Date(now)) : undefined;

    const recordPayload = {
      prompt: input.prompt.trim(),
      allowedTools: input.allowedTools ?? [],
      timeoutSeconds: 300,
    };

    const routine: AgentRoutine = {
      routineId,
      automationId,
      agentId: input.agentId || "default",
      name: input.name.trim(),
      triggerDescription,
      triggerPresentationJson: JSON.stringify(schedule),
      schedule: input.scheduleType === "cron" ? input.cron || "" : `${schedule.intervalMinutes}m`,
      isEnabled,
      nextRunAtMs,
      createdAtMs: now,
      updatedAtMs: now,
      runAsDisplayName: input.runAsDisplayName || "OpenSand Routine Agent",
      recordJson: JSON.stringify(recordPayload),
      runCount: 0,
    };

    await this.saveRoutine(routine);
    return routine;
  }

  private async saveRoutine(routine: AgentRoutine): Promise<void> {
    await this.ensureDirectories();
    const filePath = this.routineFilePath(routine.routineId);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const content = JSON.stringify(routine, null, 2);

    await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
    const fh = await fs.open(tempPath, "r+");
    await fh.sync();
    await fh.close();

    await fs.rename(tempPath, filePath);
  }

  /**
   * List all stored routines
   */
  async listRoutines(): Promise<AgentRoutine[]> {
    await this.ensureDirectories();
    const files = await fs.readdir(this.baseDir);
    const routines: AgentRoutine[] = [];

    for (const f of files) {
      if (!f.endsWith(".json") || f.includes(".tmp.")) continue;
      try {
        const fullPath = path.join(this.baseDir, f);
        const data = await fs.readFile(fullPath, "utf8");
        const routine = JSON.parse(data) as AgentRoutine;
        routines.push(routine);
      } catch {
        // Skip malformed entries
      }
    }

    return routines.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /**
   * Get routine by ID
   */
  async getRoutine(routineId: string): Promise<AgentRoutine | null> {
    try {
      const filePath = this.routineFilePath(routineId);
      const data = await fs.readFile(filePath, "utf8");
      return JSON.parse(data) as AgentRoutine;
    } catch {
      return null;
    }
  }

  /**
   * Enable or disable a routine
   */
  async setRoutineEnabled(routineId: string, isEnabled: boolean): Promise<AgentRoutine> {
    const routine = await this.getRoutine(routineId);
    if (!routine) {
      throw new Error(`Routine with id ${routineId} not found`);
    }

    const now = Date.now();
    routine.isEnabled = isEnabled;
    routine.updatedAtMs = now;

    if (isEnabled) {
      let schedule: RoutineSchedule;
      try {
        schedule = JSON.parse(routine.triggerPresentationJson);
      } catch {
        schedule = { type: "interval", intervalMinutes: 60 };
      }
      routine.nextRunAtMs = computeNextRunAtMs(schedule, new Date(now));
    } else {
      routine.nextRunAtMs = undefined;
    }

    await this.saveRoutine(routine);
    return routine;
  }

  /**
   * Delete a routine and its logs
   */
  async deleteRoutine(routineId: string): Promise<boolean> {
    const filePath = this.routineFilePath(routineId);
    try {
      await fs.unlink(filePath);
    } catch {
      return false;
    }

    const logPath = this.logFilePath(routineId);
    try {
      await fs.unlink(logPath);
    } catch {
      // Ignore if log doesn't exist
    }

    return true;
  }

  /**
   * Manually or automatically execute a routine turn
   */
  async triggerRoutine(routineId: string): Promise<{
    routine: AgentRoutine;
    result: string;
    status: "success" | "error";
  }> {
    const routine = await this.getRoutine(routineId);
    if (!routine) {
      throw new Error(`Routine ${routineId} not found`);
    }

    const startTime = Date.now();
    routine.lastRunStatus = "running";
    await this.saveRoutine(routine);

    let result = "";
    let status: "success" | "error" = "success";
    let errorMsg: string | undefined;

    try {
      if (this.executor) {
        const execOutput = await this.executor(routine);
        result = execOutput.result;
        status = execOutput.status;
        errorMsg = execOutput.error;
      } else {
        // Default execution stub if no external turn coordinator attached
        result = `Executed routine '${routine.name}' successfully.`;
      }
    } catch (err) {
      status = "error";
      errorMsg = err instanceof Error ? err.message : String(err);
      result = `Execution failed: ${errorMsg}`;
    }

    // Auto-scrub output with VaultStore if available
    if (this.vaultStore) {
      result = this.vaultStore.redactText(result);
    }

    const completedTime = Date.now();
    routine.lastRunAtMs = completedTime;
    routine.lastRunStatus = status;
    routine.lastRunResult = result;
    routine.runCount += 1;
    routine.updatedAtMs = completedTime;

    // Schedule next run if enabled
    if (routine.isEnabled) {
      let schedule: RoutineSchedule;
      try {
        schedule = JSON.parse(routine.triggerPresentationJson);
      } catch {
        schedule = { type: "interval", intervalMinutes: 60 };
      }
      routine.nextRunAtMs = computeNextRunAtMs(schedule, new Date(completedTime));
    }

    await this.saveRoutine(routine);

    // Record to execution log
    const logEntry: RoutineExecutionLog = {
      logId: `log_${crypto.randomBytes(6).toString("hex")}`,
      routineId: routine.routineId,
      routineName: routine.name,
      startedAtMs: startTime,
      completedAtMs: completedTime,
      status,
      result,
      error: errorMsg,
    };

    await this.appendExecutionLog(routine.routineId, logEntry);

    return { routine, result, status };
  }

  private async appendExecutionLog(routineId: string, log: RoutineExecutionLog): Promise<void> {
    await this.ensureDirectories();
    const logPath = this.logFilePath(routineId);
    await fs.appendFile(logPath, JSON.stringify(log) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  /**
   * Get execution logs for a routine
   */
  async getRoutineLogs(routineId: string): Promise<RoutineExecutionLog[]> {
    const logPath = this.logFilePath(routineId);
    try {
      const data = await fs.readFile(logPath, "utf8");
      return data
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as RoutineExecutionLog);
    } catch {
      return [];
    }
  }

  /**
   * Single background ticker cycle
   */
  async tick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      const routines = await this.listRoutines();

      for (const routine of routines) {
        if (!routine.isEnabled) continue;
        if (routine.nextRunAtMs && routine.nextRunAtMs <= now) {
          try {
            await this.triggerRoutine(routine.routineId);
          } catch {
            // Error logged inside triggerRoutine, keep ticker resilient
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Start background evaluation ticker
   */
  start(intervalMs = 15000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, intervalMs);
    // Unref so ticker does not block process shutdown
    this.timer.unref();
  }

  /**
   * Stop background evaluation ticker
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
