// Shape of the IPC send arguments, kept separate so the renderer's pass-through is testable.
export type QuerySendArgs = [query: string, sessionId?: string, agentId?: string];

export function querySendArgs(
  query: string,
  sessionId?: string | null,
  agentId?: string | null,
): QuerySendArgs {
  return [query, sessionId || undefined, agentId || undefined];
}
