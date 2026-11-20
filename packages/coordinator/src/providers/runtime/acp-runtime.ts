/**
 * ACP (Agent Client Protocol) runtime shared by every CLI provider that speaks
 * JSON-RPC 2.0 over stdio. Implements the initialize → session/new →
 * session/prompt handshake, id-correlated requests, fail-closed permissions,
 * streamed text/tool events, and bounded sessions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
} from "@opensand/shared";
import { RpcTransport, type RpcId } from "./rpc-transport.js";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  workspace?: string;
}

export interface AcpRuntimeOptions<Config extends AcpConfig = AcpConfig> {
  driverKind: string;
  displayName: string;
  models: ModelCatalog;
  spawnArgs: (config: Config) => string[];
  clientName: string;
  clientVersion?: string;
  modelConfigId?: string;
  install?: { docsUrl: string };
  /** Session-scoped configuration, e.g. Antigravity's permission `mode`. */
  configureSession?: (
    request: (method: string, params: unknown) => Promise<unknown>,
    sessionId: string,
    turn: SendTurnInput,
    config: Config
  ) => Promise<void>;
}

interface AcpSession {
  child: ChildProcess;
  rpc: RpcTransport;
  sessionId: string | null;
  initialized: boolean;
  lastText: string;
  pendingTurn: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  permissions: Map<RpcId, { allowOptionId: string | null; resolve: (optionId: string | null) => void; timer: ReturnType<typeof setTimeout> }>;
  stopped: boolean;
}

const TURN_TIMEOUT_MS = 120_000;
const PERMISSION_TIMEOUT_MS = 15 * 60_000;

/** Build a ProviderInstance backed by an ACP subprocess. */
export function createAcpInstance<Config extends AcpConfig>(
  input: DriverCreateInput<Config>,
  options: AcpRuntimeOptions<Config>
): ProviderInstance {
  const { config } = input;
  const sessions = new Map<string, AcpSession>();
  const listeners = new Set<(event: unknown) => void>();
  let disposed = false;

  const emit = (event: unknown): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A bad listener must not break a turn.
      }
    }
  };

  const settleTurn = (session: AcpSession, error?: Error, value?: unknown): void => {
    const pending = session.pendingTurn;
    if (!pending) return;
    session.pendingTurn = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  };

  const answerPermissions = (session: AcpSession, optionId: string | null): void => {
    for (const [id] of session.permissions) {
      answerPermission(session, id, optionId);
    }
  };

  const answerPermission = (session: AcpSession, id: RpcId, optionId: string | null): void => {
    const pending = session.permissions.get(id);
    if (!pending) return;
    session.permissions.delete(id);
    clearTimeout(pending.timer);
    try {
      session.rpc.respond(
        id,
        optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } }
      );
    } catch {
      // The child may have exited while a permission was pending. Fail closed.
    }
  };

  const closeSession = (threadId: string): void => {
    const session = sessions.get(threadId);
    if (!session) return;
    sessions.delete(threadId);
    session.stopped = true;
    settleTurn(session, new Error(`${options.driverKind} session stopped`));
    answerPermissions(session, null);
    session.rpc.close();
    if (!session.child.killed) session.child.kill("SIGTERM");
  };

  const spawnSession = (threadId: string): AcpSession => {
    const env = { ...process.env, ...input.environment };
    const args = options.spawnArgs(config);
    const child = spawn(config.cli, args, { env, stdio: ["pipe", "pipe", "pipe"] });

    let session!: AcpSession;
    const rpc = new RpcTransport({
      child,
      label: `${options.driverKind} (${threadId})`,
      onNotification: (method, params) => {
        if (method !== "session/update") return;
        const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
        if (!update || typeof update !== "object") return;
        const kind = update.sessionUpdate;
        if (kind === "agent_message_chunk") {
          const content = update.content as { text?: string } | undefined;
          const text = content?.text;
          if (typeof text === "string") {
            session.lastText += text;
            emit({ type: "text.delta", threadId, text });
          }
        } else if (kind === "agent_thought_chunk") {
          emit({ type: "reasoning.delta", threadId, ...update });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          emit({ type: "tool.call", threadId, ...update });
        }
      },
      onServerRequest: (id, method, params) => {
        if (method !== "session/request_permission") {
          rpc.reject(id, -32601, `Unsupported request: ${method}`);
          return;
        }
        const offered = (params as { options?: Array<{ optionId: string; kind?: string; name?: string }> } | undefined)?.options ?? [];
        // OMB rule: only an `allow`-kind option approves; option order is never a security contract.
        const allow = offered.find((o) => o.kind?.toLowerCase().startsWith("allow"));
        if (config.fullAuto) {
          rpc.respond(id, allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } });
          return;
        }
        emit({ type: "permission.request", threadId, requestId: String(id), options: offered });
        const timer = setTimeout(() => answerPermission(session, id, null), PERMISSION_TIMEOUT_MS);
        timer.unref?.();
        session.permissions.set(id, {
          allowOptionId: allow?.optionId ?? null,
          resolve: (optionId) => answerPermission(session, id, optionId),
          timer,
        });
      },
    });

    session = {
      child,
      rpc,
      sessionId: null,
      initialized: false,
      lastText: "",
      pendingTurn: null,
      permissions: new Map(),
      stopped: false,
    };
    sessions.set(threadId, session);
    child.on("exit", () => {
      if (sessions.get(threadId) === session) sessions.delete(threadId);
      settleTurn(session, new Error(`${options.driverKind} process exited`));
      answerPermissions(session, null);
    });
    return session;
  };

  const getSession = (threadId: string): AcpSession => {
    const existing = sessions.get(threadId);
    if (existing && !existing.stopped) return existing;
    return spawnSession(threadId);
  };

  const initSession = async (session: AcpSession): Promise<void> => {
    if (session.initialized) return;
    await session.rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: options.clientName, version: options.clientVersion ?? "0.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    session.initialized = true;
  };

  const sendTurn = async (turn: SendTurnInput): Promise<{ text: string; toolCalls: unknown[] }> => {
    if (disposed) throw new Error(`${options.driverKind} provider ${input.instanceId} is disposed`);
    const session = getSession(turn.threadId);
    session.lastText = "";

    await initSession(session);

    const resumeId = typeof turn.resumeCursor === "string" && !turn.sessionReset ? turn.resumeCursor : null;
    const newSession = await session.rpc.request<{ sessionId?: string }>(
      resumeId ? "session/load" : "session/new",
      {
        ...(resumeId ? { sessionId: resumeId } : {}),
        cwd: config.workspace ?? process.cwd(),
        mcpServers: [],
      }
    );
    session.sessionId = typeof newSession?.sessionId === "string" ? newSession.sessionId : null;
    if (!session.sessionId) throw new Error(`${options.driverKind} did not return a sessionId`);

    if (options.configureSession) {
      await options.configureSession(
        (method, params) => session.rpc.request(method, params),
        session.sessionId,
        turn,
        config
      );
    } else if (options.modelConfigId && turn.model) {
      await session.rpc.request("session/set_config_option", {
        sessionId: session.sessionId,
        configId: options.modelConfigId,
        value: turn.model,
      });
    }

    const completion = new Promise<{ text: string; toolCalls: unknown[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingTurn = null;
        reject(new Error(`${options.driverKind} turn timed out for thread ${turn.threadId}`));
      }, TURN_TIMEOUT_MS);
      timer.unref?.();
      session.pendingTurn = {
        resolve: (value) => resolve(value as { text: string; toolCalls: unknown[] }),
        reject,
        timer,
      };
    });

    const text = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
    let result: { stopReason?: string; usage?: Record<string, number> };
    try {
      result = await session.rpc.request<{ stopReason?: string; usage?: Record<string, number> }>(
        "session/prompt",
        { sessionId: session.sessionId, prompt: [{ type: "text", text }] }
      );
    } catch (error) {
      settleTurn(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    const reason = result?.stopReason;
    if (reason === "end_turn" || reason === "cancelled") {
      settleTurn(session, undefined, { text: session.lastText, toolCalls: [] });
    } else {
      settleTurn(session, new Error(`${options.driverKind} turn ended with stopReason: ${reason ?? "unknown"}`));
    }
    return completion;
  };

  const instance: ProviderInstance = {
    instanceId: input.instanceId,
    driverKind: options.driverKind as ProviderInstance["driverKind"],
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return options.models;
    },
    async refreshModels() {
      // Static catalog; ACP model discovery is a separate, feature-flagged surface.
    },
    async snapshot(): Promise<ProviderSnapshot> {
      return {
        instanceId: input.instanceId,
        driverKind: options.driverKind as ProviderInstance["driverKind"],
        enabled: input.enabled,
        ...(config.cli ? {} : { error: { code: "missing_cli", message: "No CLI configured" } }),
      };
    },
    adapter: {
      provider: options.driverKind as ProviderInstance["driverKind"],
      capabilities: {
        sessionModelSwitch: "in-session",
        guestTurns: "confined",
        agentsMcp: false,
        customMcp: true,
        computerMcp: false,
        composioMcp: false,
        mcpToolsFoundByName: false,
        phoneMcp: false,
        browserMcp: false,
        dataMcp: false,
        emailMcp: false,
        deviceMcp: false,
        images: false,
        nativeImageInput: false,
        effortLevels: [],
        queueing: false,
        steerImages: false,
        strictResume: true,
        localComputerMcp: false,
        hooks: false,
      },
      sendTurn,
      steer(_threadId, _instruction) {
        // ACP has no steer method; a cancel/re-prompt is the caller's decision.
        return Promise.resolve();
      },
      async interruptTurn(threadId) {
        const session = sessions.get(threadId);
        if (!session?.sessionId || session.rpc.isClosed) return;
        session.rpc.notify("session/cancel", { sessionId: session.sessionId });
        settleTurn(session, new Error("Turn cancelled"));
        answerPermissions(session, null);
      },
      async respondToRequest(threadId, requestId, decision) {
        const session = sessions.get(threadId);
        if (!session) return "unavailable";
        const id = Number(requestId);
        if (!Number.isInteger(id) || !session.permissions.has(id)) return "unavailable";
        const pending = session.permissions.get(id);
        if (!pending) return "unavailable";
        if (decision.behavior === "allow" && pending.allowOptionId) {
          pending.resolve(pending.allowOptionId);
          return "allowed-once";
        }
        pending.resolve(null);
        return decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession(threadId) {
        return sessions.has(threadId);
      },
      enginePid(threadId) {
        return sessions.get(threadId)?.child.pid;
      },
      async stopAll() {
        for (const threadId of Array.from(sessions.keys())) closeSession(threadId);
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async generateText(prompt, genOptions) {
      const threadId = `text_${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`;
      const result = await sendTurn({ threadId, text: prompt });
      genOptions?.onUsage?.({
        model: genOptions?.model ?? options.models.default,
        input: prompt.length,
        output: result.text.length,
      });
      return result.text;
    },
    async dispose() {
      disposed = true;
      for (const threadId of Array.from(sessions.keys())) closeSession(threadId);
      listeners.clear();
    },
  };

  return instance;
}
