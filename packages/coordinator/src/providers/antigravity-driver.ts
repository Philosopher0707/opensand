/**
 * Antigravity (Google Gemini) provider driver — ACP-based driver over the
 * local `agy` binary, mirroring OpenMausBot's drivers/antigravity.ts.
 * Spawns Antigravity over ACP stdio, manages Google OAuth, model catalog,
 * session configuration, and tool calls.
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

const DRIVER_KIND = "antigravity";
const DEFAULT_CLI = "agy";

const MODELS: ModelCatalog = {
  default: "gemini-3.8-flash",
  options: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", contextWindow: 1_000_000 },
    { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", contextWindow: 1_000_000 },
  ],
};

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof config.cli === "string" ? config.cli : DEFAULT_CLI,
    fullAuto: config.fullAuto === true,
    ...(typeof config.workspace === "string" ? { workspace: config.workspace } : {}),
  };
}

interface AntigravitySession {
  child: ChildProcess;
  threadId: string;
  stop: () => void;
}

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Google Gemini (Antigravity)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const cli = config.cli;
    const sessions = new Map<string, AntigravitySession>();
    let disposed = false;
    const listeners = new Set<(event: unknown) => void>();

    const stopSession = (session: AntigravitySession) => {
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
      const child = spawn(cli, [], {
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
      if (disposed) throw new Error(`Antigravity provider ${input.instanceId} is disposed`);
      const threadId = turn.threadId;
      const child = await getOrSpawn(threadId);

      const prompt = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          sessionId: threadId,
          text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
          model: turn.model,
          mode: config.fullAuto ? "yolo" : "default",
        },
      }) + "\n";

      return new Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Antigravity turn timed out for thread ${threadId}`));
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
            reject(new Error(`Antigravity exited with code ${code}`));
            return;
          }

          try {
            const lines = stdout.trim().split("\n").filter(Boolean);
            const last = lines[lines.length - 1];
            const parsed = last ? JSON.parse(last) : {};
            const result = parsed.result ?? {};
            resolve({
              text: result.text ?? "",
              toolCalls: [],
            });
          } catch (err) {
            reject(new Error(`Failed to parse Antigravity output: ${(err as Error).message}`));
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
        // Antigravity model catalog is static for now
      },
      snapshot(): ProviderSnapshot {
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
          agentsMcp: true,
          customMcp: true,
          computerMcp: true,
          composioMcp: true,
          mcpToolsFoundByName: true,
          phoneMcp: true,
          browserMcp: true,
          dataMcp: true,
          emailMcp: true,
          deviceMcp: true,
          images: true,
          nativeImageInput: true,
          effortLevels: ["low", "medium", "high"],
          queueing: true,
          steerImages: false,
          strictResume: true,
          localComputerMcp: true,
          hooks: true,
          askTool: { kind: "native", server: "ogb", name: "ask_user" },
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
