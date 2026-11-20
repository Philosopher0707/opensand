/**
 * Claude Code CLI runtime: one retained `claude -p --output-format stream-json
 * --input-format stream-json` process per thread, stdin left open, turns
 * framed as stream-json user messages and settled by the `result` event.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { killProcessTree } from "../../proc-tree.js";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
} from "@opensand/shared";

export interface ClaudeConfig {
  cli: string;
  fullAuto: boolean;
  configDir?: string;
}

export interface ClaudeRuntimeOptions {
  driverKind: string;
  displayName: string;
  models: ModelCatalog;
  effortLevels?: string[];
}

interface ClaudeSession {
  child: ChildProcess;
  sessionId: string | null;
  lastText: string;
  pendingTurn: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  stopped: boolean;
}

const TURN_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 2 * 1024 * 1024;

function permissionMode(turn: SendTurnInput, fullAuto: boolean): string {
  const mode = typeof turn.approvalModeNow === "function" ? turn.approvalModeNow() : turn.approvalMode;
  if (fullAuto || mode === "full" || mode === "bypassPermissions") return "bypassPermissions";
  if (mode === "edits" || mode === "auto" || mode === "acceptEdits") return "acceptEdits";
  return "default";
}

/** Build a ProviderInstance backed by the Claude Code stream-json CLI. */
export function createClaudeInstance(
  input: DriverCreateInput<ClaudeConfig>,
  options: ClaudeRuntimeOptions
): ProviderInstance {
  const { config } = input;
  const sessions = new Map<string, ClaudeSession>();
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

  const settleTurn = (session: ClaudeSession, error?: Error, value?: unknown): void => {
    const pending = session.pendingTurn;
    if (!pending) return;
    session.pendingTurn = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  };

  const closeSession = (threadId: string): void => {
    const session = sessions.get(threadId);
    if (!session) return;
    sessions.delete(threadId);
    session.stopped = true;
    settleTurn(session, new Error("Session stopped"));
    killProcessTree(session.child);
  };

  const handleLine = (threadId: string, session: ClaudeSession, line: string): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = message.type;
    if (type === "system" && message.subtype === "init") {
      if (typeof message.session_id === "string") session.sessionId = message.session_id;
      emit({ type: "session.started", threadId, sessionId: session.sessionId });
      return;
    }

    if (type === "stream_event") {
      const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        session.lastText += event.delta.text;
        emit({ type: "text.delta", threadId, text: event.delta.text });
      } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        emit({ type: "reasoning.delta", threadId, delta: event.delta });
      }
      return;
    }

    if (type === "assistant") {
      const content = message.message as { content?: Array<{ type: string; text?: string; name?: string; id?: string }> } | undefined;
      for (const block of content?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          emit({ type: "assistant_text", threadId, text: block.text });
        } else if (block.type === "tool_use") {
          emit({ type: "tool.call", threadId, name: block.name, id: block.id });
        }
      }
      return;
    }

    if (type === "user") {
      const content = message.message as { content?: Array<{ type: string }> } | undefined;
      for (const block of content?.content ?? []) {
        if (block.type === "tool_result") emit({ type: "tool.result", threadId });
      }
      return;
    }

    if (type === "result") {
      const failed = message.is_error === true;
      if (failed) {
        settleTurn(session, new Error(typeof message.result === "string" ? message.result : "Claude Code turn failed"));
      } else {
        const text = typeof message.result === "string" && message.result
          ? message.result
          : session.lastText;
        settleTurn(session, undefined, { text, toolCalls: [] });
      }
    }
  };

  const spawnSession = (threadId: string, turn: SendTurnInput): ClaudeSession => {
    const resumeId = typeof turn.resumeCursor === "string" && !turn.sessionReset ? turn.resumeCursor : null;
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", permissionMode(turn, config.fullAuto),
      ...(resumeId ? ["--resume", resumeId] : ["--session-id", randomUUID()]),
    ];
    const env = { ...process.env, ...input.environment };
    const child = spawn(config.cli, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const session: ClaudeSession = {
      child,
      sessionId: resumeId,
      lastText: "",
      pendingTurn: null,
      stopped: false,
    };
    sessions.set(threadId, session);

    const stdout = child.stdout;
    if (!stdout || !child.stdin) {
      child.kill("SIGTERM");
      sessions.delete(threadId);
      throw new Error(`${options.driverKind}: child process has no stdio pipes`);
    }
    stdout.setEncoding("utf8");
    let buffer = "";
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        buffer = "";
        settleTurn(session, new Error("Claude Code output exceeded size limit"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handleLine(threadId, session, line);
        newline = buffer.indexOf("\n");
      }
    });

    child.on("exit", () => {
      if (sessions.get(threadId) === session) sessions.delete(threadId);
      settleTurn(session, new Error("Claude Code process exited before completing the turn"));
    });
    return session;
  };

  const sendTurn = async (turn: SendTurnInput): Promise<{ text: string; toolCalls: unknown[] }> => {
    if (disposed) throw new Error(`${options.driverKind} provider ${input.instanceId} is disposed`);
    let session = sessions.get(turn.threadId);
    if (!session || session.stopped) session = spawnSession(turn.threadId, turn);
    session.lastText = "";

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

    const content = turn.system
      ? `${turn.system}\n\n${turn.text}`
      : turn.text;
    const prompt = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
    const stdin = session.child.stdin;
    if (!stdin) throw new Error(`${options.driverKind}: child stdin is not writable`);
    stdin.write(prompt);
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
    async refreshModels() {},
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
        customMcp: false,
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
        effortLevels: options.effortLevels ?? [],
        queueing: true,
        steerImages: false,
        strictResume: true,
        localComputerMcp: false,
        hooks: false,
      },
      sendTurn,
      steer() {
        return Promise.resolve();
      },
      async interruptTurn(threadId) {
        const session = sessions.get(threadId);
        if (!session) return;
        settleTurn(session, new Error("Turn cancelled"));
        if (!session.child.killed) session.child.kill("SIGTERM");
      },
      respondToRequest() {
        return Promise.resolve("unavailable");
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
