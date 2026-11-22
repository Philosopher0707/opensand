/**
 * Codex app-server runtime: NDJSON JSON-RPC 2.0 over `codex app-server`.
 * Handshake is initialize → initialized → thread/start → turn/start; a turn
 * completes on the `turn/completed` notification, not on the turn/start reply.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { killProcessTree } from "../../proc-tree.js";
import { startIdleReaper } from "../../engine-idle.js";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
} from "@opensand/shared";
import { RpcTransport, type RpcId } from "./rpc-transport.js";

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
  authMode?: "chatgpt-plan";
}

export interface CodexRuntimeOptions {
  driverKind: string;
  displayName: string;
  models: ModelCatalog;
  effortLevels?: string[];
}

interface CodexSession {
  child: ChildProcess;
  rpc: RpcTransport;
  threadId: string | null;
  turnId: string | null;
  lastUsedAt: number;
  initialized: boolean;
  lastText: string;
  pendingTurn: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  permissions: Map<RpcId, { legacy: boolean; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }>;
  stopped: boolean;
}

const TURN_TIMEOUT_MS = 120_000;
const PERMISSION_TIMEOUT_MS = 15 * 60_000;
const APPROVAL_METHODS = new Set([
  "execCommandApproval",
  "applyPatchApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/** Build a ProviderInstance backed by the Codex app-server protocol. */
export function createCodexInstance(
  input: DriverCreateInput<CodexConfig>,
  options: CodexRuntimeOptions
): ProviderInstance {
  const { config } = input;
  const sessions = new Map<string, CodexSession>();
  const listeners = new Set<(event: unknown) => void>();
  let models = options.models;
  let modelsUnconfirmed = false;
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

  const settleTurn = (session: CodexSession, error?: Error, value?: unknown): void => {
    const pending = session.pendingTurn;
    if (!pending) return;
    session.pendingTurn = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  };

  const answerPermission = (session: CodexSession, id: RpcId, allow: boolean): void => {
    const pending = session.permissions.get(id);
    if (!pending) return;
    session.permissions.delete(id);
    clearTimeout(pending.timer);
    try {
      session.rpc.respond(id, {
        decision: allow ? (pending.legacy ? "approved" : "accept") : pending.legacy ? "denied" : "decline",
      });
    } catch {
      // Child exited while the approval was pending — fail closed.
    }
  };

  const answerAllPermissions = (session: CodexSession, allow: boolean): void => {
    for (const id of Array.from(session.permissions.keys())) answerPermission(session, id, allow);
  };

  const closeSession = (threadId: string): void => {
    const session = sessions.get(threadId);
    if (!session) return;
    sessions.delete(threadId);
    session.stopped = true;
    settleTurn(session, new Error("Session stopped"));
    answerAllPermissions(session, false);
    session.rpc.close();
    killProcessTree(session.child);
  };
  const stopIdleReaper = startIdleReaper(sessions, closeSession);

  const spawnSession = (threadId: string): CodexSession => {
    const env = { ...process.env, ...input.environment };
    const child = spawn(config.cli, ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let session!: CodexSession;
    const rpc = new RpcTransport({
      child,
      label: `${options.driverKind} (${threadId})`,
      onNotification: (method, params) => {
        if (method === "item/agentMessage/delta") {
          const delta = (params as { delta?: string } | undefined)?.delta;
          if (typeof delta === "string") {
            session.lastText += delta;
            emit({ type: "text.delta", threadId, text: delta });
          }
          return;
        }
        if (method === "item/started" || method === "item/completed") {
          const item = (params as { item?: { type?: string; text?: string; name?: string; id?: string; command?: string } } | undefined)?.item;
          if (!item || typeof item.type !== "string") return;
          if (item.type === "agentMessage" && typeof item.text === "string") {
            session.lastText = item.text;
          } else if (item.type !== "userMessage") {
            emit({ type: method === "item/started" ? "tool.call" : "tool.result", threadId, name: item.name ?? item.command ?? item.type, id: item.id });
          }
          return;
        }
        if (method === "thread/tokenUsage/updated") {
          emit({ type: "token.usage", threadId, usage: params });
          return;
        }
        if (method === "turn/completed") {
          const turn = (params as { turn?: { status?: string; error?: { message?: string }; id?: string } } | undefined)?.turn;
          if (turn?.status === "completed") {
            settleTurn(session, undefined, { text: session.lastText, toolCalls: [] });
          } else {
            settleTurn(session, new Error(turn?.error?.message ?? `Codex turn ${turn?.status ?? "failed"}`));
          }
        }
      },
      onServerRequest: (id, method) => {
        if (!APPROVAL_METHODS.has(method)) {
          rpc.reject(id, -32601, `Unsupported request: ${method}`);
          return;
        }
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        if (config.fullAuto) {
          rpc.respond(id, { decision: legacy ? "approved" : "accept" });
          return;
        }
        emit({ type: "permission.request", threadId, requestId: String(id), method });
        const timer = setTimeout(() => answerPermission(session, id, false), PERMISSION_TIMEOUT_MS);
        timer.unref?.();
        session.permissions.set(id, { legacy, resolve: (allow) => answerPermission(session, id, allow), timer });
      },
    });

    session = {
      child,
      rpc,
      threadId: null,
      turnId: null,
      lastUsedAt: Date.now(),
      initialized: false,
      lastText: "",
      pendingTurn: null,
      permissions: new Map(),
      stopped: false,
    };
    sessions.set(threadId, session);
    child.on("exit", () => {
      if (sessions.get(threadId) === session) sessions.delete(threadId);
      settleTurn(session, new Error("Codex app-server exited before completing the turn"));
      answerAllPermissions(session, false);
    });
    return session;
  };

  const getSession = (threadId: string): CodexSession => {
    const existing = sessions.get(threadId);
    if (existing && !existing.stopped) return existing;
    return spawnSession(threadId);
  };

  const initSession = async (session: CodexSession): Promise<void> => {
    if (session.initialized) return;
    await session.rpc.request("initialize", {
      clientInfo: { name: "opensand", title: "OpenSand", version: "0.1.4" },
      capabilities: { experimentalApi: true },
    });
    session.rpc.notify("initialized", {});
    session.initialized = true;
  };

  const sendTurn = async (turn: SendTurnInput): Promise<{ text: string; toolCalls: unknown[] }> => {
    if (disposed) throw new Error(`${options.driverKind} provider ${input.instanceId} is disposed`);
    const session = getSession(turn.threadId);
    session.lastUsedAt = Date.now();
    session.lastText = "";
    await initSession(session);

    const approvalPolicy = config.fullAuto || turn.approvalMode === "full" ? "never" : "on-request";
    const sandboxPolicy = config.fullAuto || turn.approvalMode === "full"
      ? { type: "danger-full-access" }
      : { type: "workspace-write" };

    const resumeId = typeof turn.resumeCursor === "string" && !turn.sessionReset ? turn.resumeCursor : null;
    const thread = await session.rpc.request<{ thread?: { id?: string } }>(
      resumeId ? "thread/resume" : "thread/start",
      {
        ...(resumeId ? { threadId: resumeId } : {}),
        cwd: process.cwd(),
        model: turn.model,
        approvalPolicy,
        sandbox: sandboxPolicy,
      }
    );
    session.threadId = typeof thread?.thread?.id === "string" ? thread.thread.id : resumeId;

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

    // Codex app-server has no protocol system channel: concatenate into the user text.
    const text = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
    let started: { turn?: { id?: string } };
    try {
      started = await session.rpc.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: session.threadId,
        input: [{ type: "text", text }],
        approvalPolicy,
        sandboxPolicy,
        ...(turn.effort ? { effort: turn.effort } : {}),
      });
    } catch (error) {
      settleTurn(session, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    session.turnId = typeof started?.turn?.id === "string" ? started.turn.id : null;

    return completion;
  };

  const instance: ProviderInstance = {
    instanceId: input.instanceId,
    driverKind: options.driverKind as ProviderInstance["driverKind"],
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    get modelsUnconfirmed() {
      return modelsUnconfirmed;
    },
    async refreshModels() {
      if (disposed) return;
      const probeId = `probe_${randomUUID()}`;
      const session = spawnSession(probeId);
      try {
        await initSession(session);
        const discovered: Array<{ id: string; label: string; contextWindow?: number }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = await session.rpc.request<{ data?: Array<{ id?: string; displayName?: string; isDefault?: boolean; hidden?: boolean; contextWindow?: number }>; nextCursor?: string }>(
            "model/list",
            { ...(cursor ? { cursor } : {}), limit: 100 },
            8_000
          );
          for (const row of result?.data ?? []) {
            if (row.hidden || typeof row.id !== "string" || !/^[\w][\w./:+-]*$/.test(row.id)) continue;
            if (discovered.some((m) => m.id === row.id)) continue;
            discovered.push({ id: row.id, label: row.displayName ?? row.id, ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}) });
          }
          cursor = result?.nextCursor;
          if (!cursor) break;
        }
        if (discovered.length) {
          const defaultId = discovered.find((m) => m.id === models.default)?.id ?? discovered[0].id;
          models = { default: defaultId, options: discovered };
          modelsUnconfirmed = false;
        } else {
          modelsUnconfirmed = true;
        }
      } catch {
        modelsUnconfirmed = true;
      } finally {
        closeSession(probeId);
      }
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
        sessionModelSwitch: "between-turns",
        guestTurns: "confined",
        agentsMcp: false,
        customMcp: true,
        computerMcp: true,
        composioMcp: true,
        mcpToolsFoundByName: false,
        phoneMcp: false,
        browserMcp: false,
        dataMcp: false,
        emailMcp: false,
        deviceMcp: false,
        images: false,
        nativeImageInput: false,
        effortLevels: options.effortLevels ?? ["low", "medium", "high"],
        queueing: true,
        steerImages: false,
        strictResume: true,
        localComputerMcp: true,
        hooks: false,
      },
      sendTurn,
      async steer(threadId, instruction) {
        const session = sessions.get(threadId);
        if (!session?.threadId || !session.turnId || session.rpc.isClosed) return;
        await session.rpc.request("turn/steer", {
          threadId: session.threadId,
          expectedTurnId: session.turnId,
          input: [{ type: "text", text: instruction }],
        });
      },
      async interruptTurn(threadId) {
        const session = sessions.get(threadId);
        if (!session?.threadId || !session.turnId || session.rpc.isClosed) return;
        session.rpc.notify("turn/interrupt", { threadId: session.threadId, turnId: session.turnId });
        settleTurn(session, new Error("Turn cancelled"));
      },
      async respondToRequest(threadId, requestId, decision) {
        const session = sessions.get(threadId);
        if (!session) return "unavailable";
        const id = Number(requestId);
        if (!Number.isInteger(id) || !session.permissions.has(id)) return "unavailable";
        const allow = decision.behavior === "allow" || decision.behavior === "answer";
        session.permissions.get(id)?.resolve(allow);
        return allow ? "allowed-once" : "rejected";
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
      stopIdleReaper();
      for (const threadId of Array.from(sessions.keys())) closeSession(threadId);
      listeners.clear();
    },
  };

  return instance;
}
