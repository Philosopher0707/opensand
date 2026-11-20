/**
 * Claude Code provider driver — CLI-based driver over the local `claude` binary,
 * mirroring OpenMausBot's drivers/claude.ts. Spawns one retained Claude CLI
 * process per thread over stream-json, manages sessions, tool calls, approvals,
 * and model catalog.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
  TextGenerationUsage,
} from "@opensand/shared";

const DRIVER_KIND = "claude-code";
const DEFAULT_CLI = "claude";

const MODELS: ModelCatalog = {
  default: "claude-3-7-sonnet-20250219",
  options: [
    { id: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", contextWindow: 200_000 },
    { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", contextWindow: 200_000 },
  ],
};

export interface ClaudeConfig {
  cli: string;
  fullAuto: boolean;
  configDir?: string;
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof config.cli === "string" ? config.cli : DEFAULT_CLI,
    fullAuto: config.fullAuto === true,
    ...(typeof config.configDir === "string" ? { configDir: config.configDir } : {}),
  };
}

interface ClaudeSession {
  child: ChildProcess;
  threadId: string;
  stop: () => void;
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Code",
    supportsMultipleInstances: true,
    access: "custom",
    cliVersion: /^(\d+)\.(\d+)\.(\d+)/,
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const cli = config.cli;
    const sessions = new Map<string, ClaudeSession>();
    let disposed = false;
    const listeners = new Set<(event: unknown) => void>();

    const stopSession = (session: ClaudeSession) => {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };

    const closeSession = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s) return;
      stopSession(s);
      sessions.delete(threadId);
    };

    const getOrSpawn = async (threadId: string): Promise<ChildProcess> => {
      let session = sessions.get(threadId);
      if (session) return session.child;

      const env = { ...process.env, ...input.environment };
      const child = spawn(cli, ["--input-format", "stream-json"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stop = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      };

      session = { child, threadId, stop };
      sessions.set(threadId, session);

      child.on("exit", () => {
        sessions.delete(threadId);
      });

      return child;
    };

    const sendTurn = async (turn: SendTurnInput) => {
      if (disposed) throw new Error(`Claude Code provider ${input.instanceId} is disposed`);
      const threadId = turn.threadId;
      const child = await getOrSpawn(threadId);

      const prompt = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
        },
      }) + "\n";

      return new Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Claude Code turn timed out for thread ${threadId}`));
        }, 120_000);

        let stdout = "";
        const onStdout = (data: Buffer) => {
          stdout += data.toString();
        };
        const onExit = (code: number | null) => {
          clearTimeout(timeout);
          child.stdout.removeListener("data", onStdout);
          child.removeListener("exit", onExit);

          if (code !== 0 && code !== null) {
            reject(new Error(`Claude Code exited with code ${code}`));
            return;
          }

          try {
            const lines = stdout.trim().split("\n").filter(Boolean);
            const last = lines[lines.length - 1];
            const parsed = last ? JSON.parse(last) : {};
            resolve({
              text: parsed.result ?? parsed.text ?? "",
              toolCalls: [],
            });
          } catch (err) {
            reject(new Error(`Failed to parse Claude Code output: ${(err as Error).message}`));
          }
        };

        child.stdout.on("data", onStdout);
        child.on("exit", onExit);

        child.stdin.write(prompt);
        child.stdin.end();
      });
    };

    const instance: ProviderInstance = {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return MODELS;
      },
      async refreshModels() {
        // Claude Code model catalog is static for now
      },
      async snapshot(): Promise<ProviderSnapshot> {
        return {
          instanceId: input.instanceId,
          driverKind: DRIVER_KIND,
          enabled: input.enabled,
        };
      },
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          guestTurns: "confined",
          agentsMcp: false,
          customMcp: false,
          computerMcp: true,
          composioMcp: false,
          mcpToolsFoundByName: false,
          phoneMcp: false,
          browserMcp: false,
          dataMcp: false,
          emailMcp: false,
          deviceMcp: false,
          images: false,
          nativeImageInput: false,
          effortLevels: ["low", "medium", "high"],
          queueing: true,
          steerImages: false,
          strictResume: true,
          localComputerMcp: true,
          hooks: false,
        },
        async sendTurn(turn) {
          return sendTurn(turn);
        },
        steer(_threadId, _instruction) {
          return Promise.resolve();
        },
        interruptTurn(threadId) {
          const s = sessions.get(threadId);
          if (s) {
            s.stop();
            sessions.delete(threadId);
          }
          return Promise.resolve();
        },
        respondToRequest(_threadId, _requestId, _decision) {
          return Promise.resolve("unavailable");
        },
        hasSession(threadId) {
          return sessions.has(threadId);
        },
        enginePid(threadId) {
          const s = sessions.get(threadId);
          return s ? s.child.pid : undefined;
        },
        async stopAll() {
          for (const [threadId] of sessions) {
            closeSession(threadId);
          }
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt, options) => {
        const threadId = `text_${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`;
        const result = await sendTurn({ threadId, text: prompt, system: undefined });
        const text = (result as { text?: string }).text ?? "";
        const usage: TextGenerationUsage = {
          model: options?.model ?? MODELS.default,
          input: prompt.length,
          output: text.length,
        };
        options?.onUsage?.(usage);
        return text;
      },
      dispose() {
        disposed = true;
        for (const [threadId] of sessions) {
          closeSession(threadId);
        }
        listeners.clear();
        return Promise.resolve();
      },
    };

    return instance;
  },
};
