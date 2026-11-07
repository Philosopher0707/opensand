import type { ChatMessage } from "@opensand/shared";
export function isTurnBoundary(m: ChatMessage): boolean { return m.role === "user"; }
export function groupByTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = []; let cur: ChatMessage[] = [];
  for (const m of messages) { if (isTurnBoundary(m) && cur.length) { turns.push(cur); cur = []; } cur.push(m); }
  if (cur.length) turns.push(cur); return turns;
}
