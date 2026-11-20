/**
 * One narrow seam for "run a real agent turn" used by rooms, routines and
 * webhooks. The desktop app wires it to a session coordinator; tests can pass
 * a fake without constructing the whole app.
 */

export interface AgentTurnExecutor {
  runTurn(input: {
    prompt: string;
    sessionId?: string;
    agentId?: string;
    source?: "room" | "routine" | "webhook";
  }): Promise<string>;
}
