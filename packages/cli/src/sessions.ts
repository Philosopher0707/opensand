import type { SessionSummary } from "@opensand/coordinator";

export interface SessionMatch {
  session?: SessionSummary;
  /** More than one session matches the typed prefix. */
  ambiguous?: SessionSummary[];
}

/** Resolve a `--resume` / `/resume` argument: "latest", an id, or a unique prefix. */
export function matchSession(sessions: SessionSummary[], query: string): SessionMatch {
  if (query === "latest") {
    return { session: sessions[0] };
  }
  const exact = sessions.find((s) => s.sessionId === query);
  if (exact) return { session: exact };
  const matches = sessions.filter((s) => s.sessionId.startsWith(query));
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return {};
}
