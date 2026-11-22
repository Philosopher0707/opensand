// Chat turn: composer, streaming transcript and the end states for the Preact shell.
// Pure, so the transitions and the event filter are tested without Electron.
import type { TurnEvent } from "./quick-capture-model.js";

export type ChatTurnStatus =
  | "idle"
  | "sending"
  | "waiting"
  | "streaming"
  | "done"
  | "error"
  | "stopped"
  | "unavailable";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** "Stopped." on the assistant message of a cancelled turn. */
  note?: string;
  /** Why this turn failed, shown in its assistant message. */
  error?: string;
}

export interface ChatTurnState {
  status: ChatTurnStatus;
  messages: ChatMessage[];
  /** Session the running turn belongs to, once the send has returned it. */
  sessionId: string | null;
  /** Error message of the last failed turn, for the status line. */
  error: string;
}

export const INITIAL_CHAT_TURN: ChatTurnState = {
  status: "idle",
  messages: [],
  sessionId: null,
  error: "",
};

export type ChatTurnAction =
  | { type: "start"; query: string }
  | { type: "sent"; sessionId: string }
  | { type: "failed"; message: string }
  | { type: "delta"; text: string }
  | { type: "approval" }
  | { type: "complete"; response?: string }
  | { type: "stopped" }
  | { type: "unavailable" }
  | { type: "load"; sessionId: string; messages: ChatMessage[] };

export function isChatBusy(status: ChatTurnStatus): boolean {
  return status === "sending" || status === "waiting" || status === "streaming";
}

/** Replaces the assistant message of the running turn, leaving the rest of the transcript alone. */
function updateAssistant(state: ChatTurnState, change: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const messages = state.messages.slice();
  const i = messages.length - 1;
  if (i < 0 || messages[i].role !== "assistant") return messages;
  messages[i] = change(messages[i]);
  return messages;
}

export function chatTurnReducer(state: ChatTurnState = INITIAL_CHAT_TURN, action: ChatTurnAction): ChatTurnState {
  switch (action.type) {
    case "start": {
      // A second send while a turn runs is ignored; the composer disables Send then.
      if (isChatBusy(state.status)) return state;
      const query = action.query.trim();
      if (!query) return state;
      return {
        status: "sending",
        messages: [...state.messages, { role: "user", text: query }, { role: "assistant", text: "" }],
        sessionId: null,
        error: "",
      };
    }
    case "sent":
      // The send can resolve after the turn already finished; only a busy turn takes the id.
      if (!isChatBusy(state.status)) return state;
      return { ...state, sessionId: action.sessionId };
    case "delta":
      if (!isChatBusy(state.status) || !action.text) return state;
      return {
        ...state,
        status: "streaming",
        messages: updateAssistant(state, (m) => ({ ...m, text: m.text + action.text })),
      };
    case "approval":
      // The turn is paused until the person answers in the Inbox; the next token or completion resumes it.
      if (!isChatBusy(state.status)) return state;
      return { ...state, status: "waiting" };
    case "complete":
      if (!isChatBusy(state.status)) return state;
      return {
        ...state,
        status: "done",
        messages: updateAssistant(state, (m) => ({ ...m, text: m.text || action.response || "" })),
      };
    case "failed":
      if (!isChatBusy(state.status)) return state;
      return {
        ...state,
        status: "error",
        error: action.message,
        messages: updateAssistant(state, (m) => ({ ...m, error: action.message })),
      };
    case "stopped":
      // Stop ends the turn at once; a late cancel or token event does not reopen it.
      if (!isChatBusy(state.status)) return state;
      return {
        ...state,
        status: "stopped",
        messages: updateAssistant(state, (m) => ({ ...m, note: "Stopped." })),
      };
    case "unavailable":
      return { ...INITIAL_CHAT_TURN, status: "unavailable" };
    case "load":
      return {
        ...INITIAL_CHAT_TURN,
        sessionId: action.sessionId,
        messages: action.messages || [],
      };
  }
}

/**
 * Maps a bridge event to a reducer action, or null when it is not for this turn.
 * An event that names a session is ignored when it is not the chat's session, so a
 * quick-window capture does not fill the transcript.
 */
export function chatEventAction(event: TurnEvent, sessionId: string | null): ChatTurnAction | null {
  const eventSession = event.sessionId ?? event.data?.sessionId;
  if (sessionId && eventSession && eventSession !== sessionId) return null;

  if (event.type === "token" || event.type === "text_delta") {
    const delta = event.data?.token || event.token || event.text || "";
    return delta ? { type: "delta", text: delta } : null;
  }
  if (event.type === "approval_required") return { type: "approval" };
  if (event.type === "turn_complete") {
    return { type: "complete", response: event.data?.response || "" };
  }
  if (event.type === "turn_cancelled") return { type: "stopped" };
  if (event.type === "error") {
    return { type: "failed", message: event.data?.message || event.message || "Unknown error occurred" };
  }
  return null;
}

/** Parses transcript text using <user_query> delimiters or fallback to single assistant answer. */
export function parseTranscriptText(transcriptText: string): ChatMessage[] {
  if (!transcriptText || typeof transcriptText !== "string") return [];
  const turns: ChatMessage[] = [];
  const userQueryRegex = /<user_query>([\s\S]*?)<\/user_query>/gi;
  let match: RegExpExecArray | null;
  const queries: Array<{ query: string; startIndex: number; endIndex: number }> = [];

  while ((match = userQueryRegex.exec(transcriptText)) !== null) {
    queries.push({
      query: match[1].trim(),
      startIndex: match.index,
      endIndex: userQueryRegex.lastIndex,
    });
  }

  if (queries.length === 0) {
    const trimmed = transcriptText.trim();
    return trimmed ? [{ role: "assistant", text: trimmed }] : [];
  }

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    turns.push({ role: "user", text: q.query });

    const assistantStart = q.endIndex;
    const assistantEnd =
      i + 1 < queries.length ? queries[i + 1].startIndex : transcriptText.length;
    let assistantSection = transcriptText.slice(assistantStart, assistantEnd).trim();
    assistantSection = assistantSection.replace(/^assistant:\s*/i, "").trim();

    if (assistantSection) {
      turns.push({ role: "assistant", text: assistantSection });
    }
  }

  return turns;
}

/** Reconstructs ChatMessage items from stored session events or transcript fallback. */
export function reconstructSessionMessages(
  sessionData:
    | { events?: unknown[]; transcript?: string; [key: string]: any }
    | unknown[]
    | null
    | undefined,
): ChatMessage[] {
  if (!sessionData) return [];

  const rawEvents: unknown[] = Array.isArray(sessionData)
    ? sessionData
    : Array.isArray(sessionData.events)
      ? sessionData.events
      : [];

  const transcriptText =
    !Array.isArray(sessionData) && typeof sessionData.transcript === "string"
      ? sessionData.transcript
      : "";

  if (rawEvents.length === 0 && transcriptText) {
    return parseTranscriptText(transcriptText);
  }

  const messages: ChatMessage[] = [];
  for (const ev of rawEvents) {
    if (!ev || typeof ev !== "object") continue;
    const item = ev as Record<string, any>;
    if (item.role === "user") {
      const text = String(item.text ?? item.content ?? "").trim();
      messages.push({ role: "user", text });
    } else if (item.role === "assistant") {
      let text = String(item.text ?? item.content ?? "");
      text = text.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, "").trim();
      messages.push({
        role: "assistant",
        text,
        ...(item.note ? { note: String(item.note) } : {}),
        ...(item.error ? { error: String(item.error) } : {}),
      });
    }
  }

  return messages;
}
