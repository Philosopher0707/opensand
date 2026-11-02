import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

const execAsync = promisify(exec);

export interface WatcherConfig {
  id: string;
  targetDir: string;
  checkCommand?: string; // e.g. "pnpm test" or "tsc -b"
  autoHeal?: boolean;
  debounceMs?: number;
  ignorePatterns?: string[];
  createdAtMs: number;
}

export interface SentinelDiagnosticEvent {
  id: string;
  watcherId: string;
  targetDir?: string;
  checkCommand?: string;
  triggerFile: string;
  timestampMs: number;
  status: "clean" | "error" | "healing" | "healed";
  output: string;
  errorMessage?: string;
  healingProposal?: string;
}

export type SentinelHealerCallback = (event: SentinelDiagnosticEvent) => Promise<{
  healed: boolean;
  proposal: string;
}>;

export interface HealerAgentRunner {
  runTurn(prompt: string): Promise<string>;
}

export function createAutonomousHealer(
  runner: HealerAgentRunner,
  options?: { maxAttempts?: number }
): SentinelHealerCallback {
  const maxAttempts = options?.maxAttempts ?? 2;
  return async (event: SentinelDiagnosticEvent) => {
    const errorDetails = event.errorMessage || event.output;
    const prompt = `[AUTOMATED SENTINEL HEALER]
A diagnostic check failed following changes to ${event.triggerFile}.
Working directory: ${event.targetDir || process.cwd()}
Failed Command: ${event.checkCommand || 'N/A'}
Error details:
${errorDetails}

Please diagnose the issue, explain the cause, and use the available file editing tools (such as edit_file or write_file) or execute_command to fix the error. Once fixed, ensure the code builds or passes tests.`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await runner.runTurn(prompt);

        if (event.checkCommand && event.targetDir) {
          try {
            await execAsync(event.checkCommand, { cwd: event.targetDir, timeout: 30000 });
            return {
              healed: true,
              proposal: response || "Fix applied and verified successfully.",
            };
          } catch (recheckErr: any) {
            if (attempt === maxAttempts) {
              return {
                healed: false,
                proposal: `Attempted fix (${attempt}/${maxAttempts}) but check still failed: ${recheckErr.message || recheckErr}`,
              };
            }
          }
        } else {
          return {
            healed: true,
            proposal: response || "Autonomous fix applied.",
          };
        }
      } catch (err: any) {
        if (attempt === maxAttempts) {
          return {
            healed: false,
            proposal: `Autonomous healing error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    return {
      healed: false,
      proposal: "Max healing attempts reached without resolution.",
    };
  };
}

export class WorkspaceSentinel extends EventEmitter {
  private activeWatchers: Map<string, { config: WatcherConfig; ac: AbortController }> = new Map();
  private diagnosticLogs: SentinelDiagnosticEvent[] = [];
  private healer?: SentinelHealerCallback;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(healer?: SentinelHealerCallback) {
    super();
    this.healer = healer;
  }

  setHealer(healer: SentinelHealerCallback): void {
    this.healer = healer;
  }

  hasHealer(): boolean {
    return !!this.healer;
  }

  getWatchers(): WatcherConfig[] {
    return Array.from(this.activeWatchers.values()).map((w) => ({ ...w.config }));
  }

  getLogs(watcherId?: string): SentinelDiagnosticEvent[] {
    if (watcherId) {
      return this.diagnosticLogs.filter((l) => l.watcherId === watcherId);
    }
    return [...this.diagnosticLogs];
  }

  /**
   * Start watching a workspace directory with automated health checks
   */
  async startWatcher(options: {
    targetDir: string;
    checkCommand?: string;
    autoHeal?: boolean;
    debounceMs?: number;
  }): Promise<WatcherConfig> {
    const resolvedDir = path.resolve(options.targetDir);
    const id = `watcher_${path.basename(resolvedDir)}_${Date.now()}`;
    const ac = new AbortController();

    const config: WatcherConfig = {
      id,
      targetDir: resolvedDir,
      checkCommand: options.checkCommand,
      autoHeal: options.autoHeal ?? false,
      debounceMs: options.debounceMs ?? 500,
      ignorePatterns: ["node_modules", ".git", "dist", ".tmp", ".cache", ".opensand"],
      createdAtMs: Date.now(),
    };

    this.activeWatchers.set(id, { config, ac });

    // Launch background fs watch loop
    this.launchWatchLoop(config, ac.signal).catch(() => {});

    return config;
  }

  private async launchWatchLoop(config: WatcherConfig, signal: AbortSignal): Promise<void> {
    try {
      const watcher = fs.watch(config.targetDir, { recursive: true, signal });
      for await (const event of watcher) {
        if (signal.aborted) break;

        const filename = event.filename;
        if (!filename) continue;

        // Check ignore patterns
        const shouldIgnore = config.ignorePatterns?.some((pattern) =>
          filename.includes(pattern) || filename.startsWith(".")
        );
        if (shouldIgnore) continue;

        this.handleFileChange(config, filename);
      }
    } catch {
      // Watcher terminated or abort signal fired
    }
  }

  private handleFileChange(config: WatcherConfig, filename: string): void {
    const existingTimer = this.debounceTimers.get(config.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(config.id);
      await this.runDiagnostic(config, filename);
    }, config.debounceMs);

    this.debounceTimers.set(config.id, timer);
  }

  /**
   * Run verification check on file change
   */
  async runDiagnostic(config: WatcherConfig, triggerFile: string): Promise<SentinelDiagnosticEvent> {
    const eventId = `diag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let status: "clean" | "error" | "healing" | "healed" = "clean";
    let output = "";
    let errorMsg: string | undefined;

    if (config.checkCommand) {
      try {
        const res = await execAsync(config.checkCommand, { cwd: config.targetDir, timeout: 30000 });
        output = res.stdout.slice(0, 5000);
      } catch (err: any) {
        status = "error";
        errorMsg = err.stderr || err.message || String(err);
        output = (err.stdout || "") + "\n" + (err.stderr || "");
      }
    } else {
      output = `File changed: ${triggerFile}. No checkCommand configured.`;
    }

    const logEvent: SentinelDiagnosticEvent = {
      id: eventId,
      watcherId: config.id,
      targetDir: config.targetDir,
      checkCommand: config.checkCommand,
      triggerFile,
      timestampMs: Date.now(),
      status,
      output: output.slice(0, 5000),
      errorMessage: errorMsg,
    };

    // If check failed and autoHeal is enabled, invoke self-healing loop
    if (status === "error" && config.autoHeal && this.healer) {
      logEvent.status = "healing";
      try {
        const healResult = await this.healer(logEvent);
        logEvent.healingProposal = healResult.proposal;
        if (healResult.healed) {
          logEvent.status = "healed";
        }
      } catch {
        // Healing failed
      }
    }

    this.diagnosticLogs.push(logEvent);
    if (this.diagnosticLogs.length > 100) {
      this.diagnosticLogs.shift();
    }

    this.emit("diagnostic", logEvent);
    return logEvent;
  }

  /**
   * Stop an active watcher
   */
  stopWatcher(watcherId: string): boolean {
    const active = this.activeWatchers.get(watcherId);
    if (!active) return false;

    active.ac.abort();
    this.activeWatchers.delete(watcherId);

    const timer = this.debounceTimers.get(watcherId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(watcherId);
    }

    return true;
  }

  /**
   * Stop all active watchers
   */
  stopAll(): void {
    for (const watcherId of Array.from(this.activeWatchers.keys())) {
      this.stopWatcher(watcherId);
    }
  }
}

export const workspaceSentinel = new WorkspaceSentinel();
