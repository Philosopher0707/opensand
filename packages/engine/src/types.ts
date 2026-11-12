import type { RequestFrame } from "@opensand/protocol";

export interface EngineConnection {
  write(line: string): void | Promise<void>;
  /** Bytes the transport has buffered and not yet handed to the client. */
  bufferedBytes(): number;
  drop?(): void;
}

export interface HandlerContext {
  stateDir: string;
  version: string;
  pid: number;
  startedAt: number;
  now: () => Date;
  connection: EngineConnection;
  subscribe: (connection: EngineConnection) => void;
  requestShutdown: (force: boolean) => void;
  activeMissions: () => number;
}

export type Handler = (
  params: Record<string, unknown>,
  context: HandlerContext
) => unknown | Promise<unknown>;

export type { RequestFrame };
