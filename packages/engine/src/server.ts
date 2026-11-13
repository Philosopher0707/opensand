import {
  ErrorCodes,
  LineDecoder,
  OspError,
  encodeLine,
  parseLine,
  type EventFrame,
  type Frame,
  type RequestFrame,
} from "@opensand/protocol";
import { createEngineHandlers } from "./handlers/engine.js";
import { createSessionHandlers } from "./handlers/sessions.js";
import { createMissionHandlers } from "./handlers/missions.js";
import { MissionRunnerManager } from "./missions/manager.js";
import type { MissionAgent } from "./missions/agent.js";
import type { EngineConnection, Handler, HandlerContext } from "./types.js";

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface EngineServerOptions {
  stateDir: string;
  version: string;
  connection: EngineConnection;
  stderr?: (message: string) => void;
  now?: () => Date;
  pid?: number;
  heartbeatIntervalMs?: number;
  onShutdown?: () => void;
  onExit?: (code: number) => void;
  missionAgent?: MissionAgent;
  /** Where folder-trust.json and grants.json live. Default: stateDir. */
  baseDir?: string;
}

export class EngineServer {
  private readonly options: Required<Pick<EngineServerOptions, "stateDir" | "version" | "connection">> &
    EngineServerOptions;
  private readonly decoder = new LineDecoder();
  private readonly handlers = new Map<string, Handler>();
  private readonly pending = new Set<Promise<void>>();
  private readonly subscribers = new Set<EngineConnection>();
  private readonly startedAt: number;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatSeq = 0;
  private shutdown: { force: boolean } | null = null;
  private exitScheduled = false;
  private readonly missionManager: MissionRunnerManager;

  constructor(options: EngineServerOptions) {
    this.options = options;
    this.startedAt = Date.now();
    this.missionManager = new MissionRunnerManager(this.options.stateDir, this.options.missionAgent, (frame) => this.broadcast(frame), { baseDir: this.options.baseDir });
    for (const [method, handler] of [
      ...Object.entries(createEngineHandlers()),
      ...Object.entries(createSessionHandlers()),
      ...Object.entries(createMissionHandlers(this.missionManager)),
    ]) {
      this.handlers.set(method, handler);
    }
  }

  start(): void {
    const interval = this.options.heartbeatIntervalMs ?? 15_000;
    if (interval <= 0) return;
    this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), interval);
    this.heartbeatTimer.unref();
  }

  handleChunk(chunk: string): void {
    for (const line of this.decoder.push(chunk)) this.dispatch(line);
  }

  /** Stops timers and waits for in-flight handlers (bounded by the caller's own timer). */
  async close(): Promise<void> {
    await this.missionManager.stopAll();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await Promise.allSettled([...this.pending]);
  }

  private dispatch(line: string): void {
    if (this.shutdown) return;

    let frame: Frame;
    try {
      frame = parseLine(line);
    } catch (err) {
      const error =
        err instanceof OspError
          ? err
          : new OspError(ErrorCodes.InternalError, String((err as Error)?.message ?? err));
      // JSON-RPC parse errors carry a null id: the request id is unknown.
      void this.send({ id: null, error: { code: error.code, message: error.message } } as unknown as Frame);
      return;
    }

    if (!("method" in frame)) {
      void this.send({
        id: (frame as { id?: string }).id ?? null,
        error: { code: ErrorCodes.InvalidRequest, message: "engine only accepts request frames" },
      } as unknown as Frame);
      return;
    }

    void this.runHandler(frame as RequestFrame);
  }

  private runHandler(request: RequestFrame): Promise<void> {
    const task = (async () => {
      try {
        const handler = this.handlers.get(request.method);
        if (!handler) {
          throw new OspError(ErrorCodes.MethodNotFound, `Unknown method ${request.method}`);
        }
        const result = await handler(request.params, this.context());
        await this.send({ id: request.id, result });
      } catch (err) {
        const error =
          err instanceof OspError
            ? err
            : new OspError(
                ErrorCodes.InternalError,
                String((err as Error)?.message ?? err)
              );
        if (!(err instanceof OspError)) {
          this.log(`handler ${request.method} threw: ${String((err as Error)?.stack ?? err)}`);
        }
        await this.send({
          id: request.id,
          error: {
            code: error.code,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data }),
          },
        });
      } finally {
        if (this.shutdown) this.finishShutdown();
      }
    })();

    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return task;
  }

  private context(): HandlerContext {
    return {
      stateDir: this.options.stateDir,
      version: this.options.version,
      pid: this.options.pid ?? process.pid,
      startedAt: this.startedAt,
      now: this.options.now ?? (() => new Date()),
      connection: this.options.connection,
      subscribe: (connection) => this.subscribers.add(connection),
      requestShutdown: (force) => {
        this.shutdown = { force };
        this.options.onShutdown?.();
      },
      activeMissions: () => this.missionManager.activeCount(),
      publish: (frame) => this.broadcast(frame),
    };
  }

  private broadcastHeartbeat(): void {
    this.heartbeatSeq += 1;
    const now = this.options.now ? this.options.now() : new Date();
    this.broadcast({
      event: "engine.Engine.heartbeat",
      seq: this.heartbeatSeq,
      ts: now.toISOString(),
      data: { timestamp: now.toISOString(), uptimeMs: Date.now() - this.startedAt },
    });
  }

  /**
   * Events reach subscribed connections only. A connection whose transport has
   * more than 4 MiB buffered is dropped instead of blocking the engine.
   */
  private broadcast(frame: EventFrame): void {
    for (const connection of this.subscribers) {
      const buffered = connection.bufferedBytes();
      if (buffered > MAX_BUFFERED_BYTES) {
        this.subscribers.delete(connection);
        this.log(`dropped slow consumer with ${buffered} buffered bytes`);
        connection.drop?.();
        continue;
      }
      void connection.write(encodeLine(frame));
    }
  }

  private async send(frame: Frame): Promise<void> {
    await this.options.connection.write(encodeLine(frame));
  }

  private finishShutdown(): void {
    if (this.exitScheduled) return;
    this.exitScheduled = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.options.onExit?.(0);
  }

  private log(message: string): void {
    this.options.stderr?.(`[engine] ${message}`);
  }
}
