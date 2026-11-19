// Chat screen in the main panel: composer, streamed answer, finished, stopped,
// error and empty states, scaffolded by scripts/screen-kit.sh. Loading is the
// thinking/streaming phase of a turn; a long answer scrolls the feed, never the
// page. Markdown rendering, tool cards and history are later rows (Phase 5
// inventory rows 3-4); this shows the answer as plain text.
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  INITIAL_CHAT_TURN,
  chatEventAction,
  chatTurnReducer,
  isChatBusy,
  type ChatMessage,
  type ChatTurnState,
} from "../../../src/shell/chat-turn-model";
import type { TurnEvent } from "../../../src/shell/quick-capture-model";

export interface ChatTurnController {
  state: ChatTurnState;
  available: boolean;
  send: (query: string) => void;
  stop: () => void;
}

export function useChatTurn(data: ShellData): ChatTurnController {
  const available = typeof data.sendQuery === "function";
  const [state, dispatch] = useReducer(
    chatTurnReducer,
    available ? INITIAL_CHAT_TURN : { ...INITIAL_CHAT_TURN, status: "unavailable" as const },
  );

  // Event handlers read the latest state without re-subscribing on every token.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!data.onTurnEvent) return;
    return data.onTurnEvent((event: TurnEvent) => {
      const action = chatEventAction(event, stateRef.current.sessionId);
      if (action) dispatch(action);
    });
  }, [data]);

  const send = (query: string) => {
    const text = query.trim();
    if (!data.sendQuery || !text || isChatBusy(stateRef.current.status)) return;
    dispatch({ type: "start", query: text });
    data.sendQuery(text).then(
      (res) => {
        if (res?.success === false) dispatch({ type: "failed", message: "The message did not send." });
        else dispatch({ type: "sent", sessionId: String(res?.sessionId ?? "") });
      },
      (err) => dispatch({ type: "failed", message: err instanceof Error ? err.message : String(err) }),
    );
  };

  const stop = () => {
    if (data.cancelTurn) Promise.resolve(data.cancelTurn()).catch(() => {});
    // The engine also sends turn_cancelled; this ends the turn even when it does not.
    dispatch({ type: "stopped" });
  };

  return { state, available, send, stop };
}

function statusText(state: ChatTurnState): string {
  switch (state.status) {
    case "sending":
      return "Sending…";
    case "waiting":
      return "Waiting for your approval in the Inbox.";
    case "streaming":
      return "Answering…";
    case "done":
      return "Answer complete.";
    case "error":
      return `Error: ${state.error}`;
    case "stopped":
      return "Stopped.";
    case "unavailable":
      return "Sending is not available in this window.";
    default:
      return "Ready.";
  }
}

/** The screen state the kit hooks read: loading, empty, ready, error. */
function screenState(state: ChatTurnState): "loading" | "empty" | "ready" | "error" {
  if (state.status === "error") return "error";
  if (state.messages.length === 0) return "empty";
  if (isChatBusy(state.status) && !state.messages[state.messages.length - 1]?.text) return "loading";
  return "ready";
}

function Avatar({ role }: { role: ChatMessage["role"] }) {
  return (
    <div class="message-avatar" aria-hidden="true">
      <svg class="icon" viewBox="0 0 24 24" focusable="false">
        {role === "user" ? (
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0" />
        ) : (
          <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" />
        )}
      </svg>
    </div>
  );
}

export function ChatMessageRow({ message }: { message: ChatMessage }) {
  const assistant = message.role === "assistant";
  return (
    <div class={`message ${assistant ? "message-assistant" : "message-user"}`}>
      <Avatar role={message.role} />
      <div class="message-body">
        {message.text ? (
          <div class="message-content chat-text">{message.text}</div>
        ) : (
          assistant && <span class="chat-thinking">Thinking…</span>
        )}
        {message.error && <div class="chat-turn-error">Error: {message.error}</div>}
        {message.note && <div class="chat-turn-note">{message.note}</div>}
      </div>
    </div>
  );
}

export function Chat({ chat }: { chat: ChatTurnController }) {
  const { state } = chat;
  const busy = isChatBusy(state.status);
  const view = screenState(state);
  const [draft, setDraft] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the stream, as the transcript grows on every token.
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [state.messages]);

  const submit = () => {
    if (busy || !draft.trim()) return;
    chat.send(draft);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  // Retry resends the last user message of the failed turn; the failed answer stays in the feed.
  const retry = () => {
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    if (lastUser && !busy) chat.send(lastUser.text);
  };

  return (
    <div
      class="chat-view"
      data-screen="chat"
      data-state={view}
      data-status={state.status}
      aria-labelledby="chat-heading"
    >
      <h2 class="chat-heading" id="chat-heading">Chat</h2>
      <div class="chat-container" id="messageFeed" aria-label="Conversation" ref={feedRef}>
        {state.messages.length === 0 ? (
          <p class="chat-empty" role="status">
            Ask OpenSand to inspect this workspace, run a command or explain a file. The answer streams
            here.
          </p>
        ) : (
          <div class="message-feed" role="list" aria-label="Messages">
            {state.messages.map((m, i) => (
              <ChatMessageRow key={i} message={m} />
            ))}
          </div>
        )}
      </div>
      {/* Always mounted, so the first status change is announced. */}
      <div class="chat-status" role="status" aria-live="polite" data-status={state.status}>
        {statusText(state)}
        {view === "error" && !busy && (
          <button type="button" class="btn btn-sm chat-retry" onClick={retry}>
            Retry
          </button>
        )}
      </div>
      <footer class="input-panel">
        <div class="input-wrapper">
          <div class="input-textarea-row">
            <textarea
              id="promptInput"
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder="Ask OpenSand…"
              aria-label="Message OpenSand"
              disabled={!chat.available}
              onInput={(e) => {
                const el = e.target as HTMLTextAreaElement;
                setDraft(el.value);
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
              }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter keeps the newline.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <div class="input-actions-bar">
            <div class="input-actions-left">
              <span class="badge badge-model">Local agent</span>
            </div>
            <div class="input-actions-right">
              <button
                id="btnSend"
                type="button"
                class="btn btn-primary btn-sm"
                disabled={busy || !chat.available || !draft.trim()}
                title={busy ? "Wait for this answer, or press Stop" : "Send (Enter)"}
                onClick={submit}
              >
                Send
              </button>
              {busy && (
                <button id="btnStop" type="button" class="btn btn-danger btn-sm" title="Stop generating" onClick={chat.stop}>
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
