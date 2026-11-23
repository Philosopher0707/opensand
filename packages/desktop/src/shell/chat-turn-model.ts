// packages/desktop/src/shell/chat-turn-model.ts
// Reducer and action mappers for the Preact chat screen.
// Encapsulates message streaming, thought blocks, tool execution cards, and session history hydration.

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

export interface ToolCallItem {
  id?: string;
  name: string;
  args?: Record<string, any> | string;
  status: "running" | "done" | "error";
  result?: any;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Accumulated thoughts or reasoning (<think> tags or thought events). */
  thought?: string;
  /** Structured tool call items executed in this turn. */
  toolCalls?: ToolCallItem[];
  /** Internal raw text buffer for streaming turns with potential <think> tags. */
  _rawText?: string;
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
  | { type: "thought"; text: string }
  | { type: "tool_call"; tool: ToolCallItem }
  | { type: "tool_result"; tool: { id?: string; name?: string; status?: "done" | "error"; result?: any } }
  | { type: "approval" }
  | { type: "complete"; response?: string }
  | { type: "stopped" }
  | { type: "unavailable" }
  | { type: "load"; sessionId: string; messages: ChatMessage[] };

export function isChatBusy(status: ChatTurnStatus): boolean {
  return status === "sending" || status === "waiting" || status === "streaming";
}

/** Retry re-sends the last user turn, so it only appears after a failure or a stop with one to send. */
export function canRetryTurn(state: ChatTurnState): boolean {
  if (isChatBusy(state.status)) return false;
  if (state.status !== "error" && state.status !== "stopped") return false;
  return state.messages.some((message) => message.role === "user");
}

/**
 * Extracts <think>...</think> or <thinking>...</thinking> blocks from raw text.
 * Also handles unclosed tags during streaming.
 */
export function extractThinking(rawText: string): { text: string; thought?: string } {
  if (!rawText) return { text: "" };
  let thought = "";
  const thinkRegex = /<(?:thinking|think)>([\s\S]*?)(?:<\/(?:thinking|think)>|$)/gi;
  let match: RegExpExecArray | null;
  const thoughts: string[] = [];
  while ((match = thinkRegex.exec(rawText)) !== null) {
    const trimmed = match[1].trim();
    if (trimmed) thoughts.push(trimmed);
  }
  if (thoughts.length > 0) {
    thought = thoughts.join("\n\n").trim();
  }
  const cleanText = rawText.replace(thinkRegex, "");
  return {
    text: thoughts.length > 0 ? cleanText.trimStart() : cleanText,
    thought: thought || undefined,
  };
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
    case "delta": {
      if (!isChatBusy(state.status) || !action.text) return state;
      return {
        ...state,
        status: "streaming",
        messages: updateAssistant(state, (m) => {
          const rawCombined = (m._rawText !== undefined ? m._rawText : m.text) + action.text;
          const { text, thought: extractedThought } = extractThinking(rawCombined);
          const thought = extractedThought || m.thought;
          const updated: ChatMessage = {
            ...m,
            text,
            ...(thought ? { thought } : {}),
          };
          if (rawCombined.includes("<think") || rawCombined.includes("<thinking") || thought) {
            updated._rawText = rawCombined;
          } else {
            delete updated._rawText;
          }
          return updated;
        }),
      };
    }
    case "thought": {
      if (!isChatBusy(state.status) || !action.text) return state;
      return {
        ...state,
        status: "streaming",
        messages: updateAssistant(state, (m) => ({
          ...m,
          thought: (m.thought ? m.thought + action.text : action.text),
        })),
      };
    }
    case "tool_call": {
      if (!isChatBusy(state.status)) return state;
      return {
        ...state,
        status: "streaming",
        messages: updateAssistant(state, (m) => {
          const calls = (m.toolCalls || []).slice();
          calls.push(action.tool);
          return { ...m, toolCalls: calls };
        }),
      };
    }
    case "tool_result": {
      if (!isChatBusy(state.status)) return state;
      return {
        ...state,
        status: "streaming",
        messages: updateAssistant(state, (m) => {
          const calls = (m.toolCalls || []).slice();
          let idx = -1;
          if (action.tool.id) {
            idx = calls.findIndex((c) => c.id === action.tool.id);
          }
          if (idx === -1 && action.tool.name) {
            idx = calls.findIndex((c) => c.name === action.tool.name && c.status === "running");
          }
          if (idx === -1) {
            idx = calls.findIndex((c) => c.status === "running");
          }
          if (idx !== -1) {
            calls[idx] = {
              ...calls[idx],
              status: action.tool.status || "done",
              result: action.tool.result,
            };
          } else {
            calls.push({
              ...(action.tool.id ? { id: action.tool.id } : {}),
              name: action.tool.name || "tool",
              status: action.tool.status || "done",
              result: action.tool.result,
            });
          }
          return { ...m, toolCalls: calls };
        }),
      };
    }
    case "approval":
      // The turn is paused until the person answers in the Inbox; the next token or completion resumes it.
      if (!isChatBusy(state.status)) return state;
      return { ...state, status: "waiting" };
    case "complete": {
      if (!isChatBusy(state.status)) return state;
      return {
        ...state,
        status: "done",
        messages: updateAssistant(state, (m) => {
          let text = m.text;
          let thought = m.thought;
          if (!text && action.response) {
            const extracted = extractThinking(action.response);
            text = extracted.text;
            thought = extracted.thought || thought;
          }
          const updated: ChatMessage = {
            ...m,
            text: text || action.response || "",
            ...(thought ? { thought } : {}),
          };
          delete updated._rawText;
          return updated;
        }),
      };
    }
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
  if (event.type === "thought" || event.type === "thought_delta") {
    const thought = event.data?.thought || event.data?.token || event.thought || event.text || "";
    return thought ? { type: "thought", text: thought } : null;
  }
  if (event.type === "tool_call" || event.type === "tool_call_started") {
    const name = event.toolCall?.function?.name || event.data?.name || event.name || "tool";
    const id = event.toolCall?.id || event.data?.id || event.id;
    let args = event.toolCall?.function?.arguments ?? event.data?.args ?? event.args ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { raw: args };
      }
    }
    return {
      type: "tool_call",
      tool: {
        ...(id ? { id } : {}),
        name,
        args,
        status: "running",
      },
    };
  }
  if (event.type === "tool_result" || event.type === "tool_call_completed") {
    const name = event.toolCall?.function?.name || event.data?.name || event.name;
    const id = event.toolCall?.id || event.data?.id || event.id || event.tool_call_id;
    const result = event.result !== undefined
      ? (event.result?.output !== undefined ? event.result.output : event.result)
      : (event.data?.result !== undefined ? event.data.result : event.output);
    return {
      type: "tool_result",
      tool: {
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        result,
        status: "done",
      },
    };
  }
  if (event.type === "approval_required") return { type: "approval" };
  if (event.type === "turn_complete") {
    return { type: "complete", response: event.data?.response || "" };
  }
  if (event.type === "turn_cancelled") return { type: "stopped" };
  if (event.type === "error") {
    const d = event.data as any;
    let text = "";
    if (d?.cause && d?.nextAction) {
      text = `${d.cause} ${d.nextAction}`;
    } else if (d?.message) {
      text = d.message;
    } else if (event.message) {
      text = event.message;
    } else {
      text = "Unknown error occurred";
    }
    return { type: "failed", message: text };
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
    if (!trimmed) return [];
    const { text, thought } = extractThinking(trimmed);
    return [{ role: "assistant", text, ...(thought ? { thought } : {}) }];
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
      const { text, thought } = extractThinking(assistantSection);
      turns.push({
        role: "assistant",
        text,
        ...(thought ? { thought } : {}),
      });
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
  let currentAssistant: ChatMessage | null = null;

  for (const ev of rawEvents) {
    if (!ev || typeof ev !== "object") continue;
    const item = ev as Record<string, any>;
    if (item.role === "user") {
      currentAssistant = null;
      const text = String(item.text ?? item.content ?? "").trim();
      messages.push({ role: "user", text });
    } else if (item.role === "assistant") {
      const rawContent = String(item.text ?? item.content ?? "");
      const { text, thought: extractedThought } = extractThinking(rawContent);
      const thought = item.thought || extractedThought || undefined;
      const toolCalls: ToolCallItem[] = [];

      if (Array.isArray(item.tool_calls) || Array.isArray(item.toolCalls)) {
        const calls = item.tool_calls || item.toolCalls;
        for (const tc of calls) {
          const name = tc.function?.name || tc.name || "tool";
          let args = tc.function?.arguments || tc.args || {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = { raw: args };
            }
          }
          toolCalls.push({
            ...(tc.id ? { id: tc.id } : {}),
            name,
            args,
            status: tc.status || "done",
            result: tc.result,
          });
        }
      }

      currentAssistant = {
        role: "assistant",
        text,
        ...(thought ? { thought } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(item.note ? { note: String(item.note) } : {}),
        ...(item.error ? { error: String(item.error) } : {}),
      };
      messages.push(currentAssistant);
    } else if (item.role === "tool") {
      if (currentAssistant) {
        if (!currentAssistant.toolCalls) currentAssistant.toolCalls = [];
        const matched =
          currentAssistant.toolCalls.find((tc) => tc.id === item.tool_call_id || tc.id === item.id) ||
          currentAssistant.toolCalls.find((tc) => tc.status === "running");
        if (matched) {
          matched.status = "done";
          matched.result = item.result ?? item.output;
        } else {
          currentAssistant.toolCalls.push({
            ...(item.tool_call_id || item.id ? { id: item.tool_call_id || item.id } : {}),
            name: item.name || "tool",
            status: "done",
            result: item.result ?? item.output,
          });
        }
      }
    } else if (item.role === "thought" || item.type === "thought") {
      if (currentAssistant) {
        const t = String(item.thought ?? item.text ?? item.content ?? "").trim();
        if (t) {
          currentAssistant.thought = currentAssistant.thought ? currentAssistant.thought + "\n\n" + t : t;
        }
      }
    }
  }

  return messages;
}
