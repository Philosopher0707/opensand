// packages/desktop/renderer-next/src/views/Chat.tsx
// Chat view: message feed, markdown rendering, collapsible thought accordions,
// structured tool execution cards, status announcement and prompt composer.

import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  INITIAL_CHAT_TURN,
  chatEventAction,
  chatTurnReducer,
  isChatBusy,
  reconstructSessionMessages,
  type ChatMessage,
  type ChatTurnAction,
  type ChatTurnState,
  type ToolCallItem,
} from "../../../src/shell/chat-turn-model";
import type { ArtifactItem } from "../../../src/shell/canvas-model";
import type { TurnEvent } from "../../../src/shell/quick-capture-model";
import { renderMarkdown } from "./chat-markdown";

export interface ChatTurnController {
  state: ChatTurnState;
  available: boolean;
  send: (query: string) => void;
  stop: () => void;
  load?: (sessionId: string, messages: ChatMessage[]) => void;
  dispatch?: (action: ChatTurnAction) => void;
}

export function useChatTurn(data: ShellData, selectedSessionId?: string | null): ChatTurnController {
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

  useEffect(() => {
    if (!selectedSessionId || !data.loadSession) return;
    let cancelled = false;
    data.loadSession(selectedSessionId).then((res) => {
      if (cancelled || !res) return;
      const messages = Array.isArray(res)
        ? res
        : Array.isArray((res as any).messages)
          ? (res as any).messages
          : reconstructSessionMessages(res);
      dispatch({ type: "load", sessionId: selectedSessionId, messages });
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [data, selectedSessionId]);

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
    dispatch({ type: "stopped" });
  };

  const load = (sessionId: string, messages: ChatMessage[]) => {
    dispatch({ type: "load", sessionId, messages });
  };

  return { state, available, send, stop, load, dispatch };
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
  if (isChatBusy(state.status) && !state.messages[state.messages.length - 1]?.text && !state.messages[state.messages.length - 1]?.thought) return "loading";
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

export function inferToolIcon(name: string): string {
  const n = (name || "").toLowerCase();
  if (n.includes("exec") || n.includes("bash") || n.includes("command") || n.includes("shell") || n.includes("terminal")) return "⚡";
  if (n.includes("read") || n.includes("view") || n.includes("cat")) return "📄";
  if (n.includes("write") || n.includes("edit") || n.includes("create") || n.includes("save")) return "✏️";
  if (n.includes("search") || n.includes("find") || n.includes("grep")) return "🔍";
  if (n.includes("browser") || n.includes("web") || n.includes("fetch") || n.includes("curl") || n.includes("http")) return "🌐";
  if (n.includes("agent") || n.includes("subagent") || n.includes("delegate")) return "🤖";
  if (n.includes("git")) return "🌿";
  return "🔧";
}

export function extractToolDetail(args: any): string {
  if (!args) return "";
  if (typeof args === "string") return args.slice(0, 80);
  if (args.command || args.cmd) return String(args.command || args.cmd).slice(0, 80);
  if (args.path || args.file || args.filename) return String(args.path || args.file || args.filename).slice(0, 80);
  if (args.query || args.prompt) return String(args.query || args.prompt).slice(0, 80);
  const keys = Object.keys(args);
  if (keys.length > 0) {
    const firstVal = args[keys[0]];
    const valStr = typeof firstVal === "object" ? JSON.stringify(firstVal) : String(firstVal);
    return `${keys[0]}: ${valStr}`.slice(0, 80);
  }
  return "";
}

export function extractFileFromTool(tool: ToolCallItem): { path: string; title: string; content: string; language: string } | null {
  const args = typeof tool.args === "object" && tool.args !== null ? tool.args : {};
  const filePath = args.path || args.file || args.filename || args.target_file || args.absolute_path || "";
  let content = args.content || args.code || args.code_content;
  if (!content && tool.result) {
    if (typeof tool.result === "string") {
      content = tool.result;
    } else if (typeof tool.result === "object" && tool.result !== null) {
      content = tool.result.content || tool.result.output || JSON.stringify(tool.result, null, 2);
    }
  }
  const name = (tool.name || "").toLowerCase();
  const isFileTool =
    name.includes("file") ||
    name.includes("read") ||
    name.includes("write") ||
    name.includes("edit") ||
    Boolean(filePath);

  if (isFileTool && (filePath || content)) {
    const p = String(filePath || `${tool.name}-output.txt`);
    const title = p.split("/").pop() || p;
    const c = typeof content === "string" ? content : (tool.result ? String(tool.result) : "");
    const ext = title.includes(".") ? title.split(".").pop()! : "text";
    return { path: p, title, content: c, language: ext };
  }
  return null;
}

export function ThoughtAccordion({ thought, isStreaming }: { thought?: string; isStreaming?: boolean }) {
  if (!thought || !thought.trim()) return null;
  const trimmed = thought.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const label = isStreaming ? `Thinking (${words} words)…` : `Thought process (${words} words)`;
  return (
    <details class={`thought-accordion ${isStreaming ? "thought-streaming" : ""}`} open={Boolean(isStreaming)}>
      <summary class="thought-header">
        <span class="thought-icon" aria-hidden="true">💭</span>
        <span class="thought-label">{label}</span>
      </summary>
      <div class="thought-body">{trimmed}</div>
    </details>
  );
}

export function ToolCard({
  tool,
  onOpenArtifact,
}: {
  tool: ToolCallItem;
  onOpenArtifact?: (artifact: Partial<ArtifactItem> & { title: string; content: string }) => void;
}) {
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const badgeText = isRunning ? "Running" : isError ? "Failed" : "Done";
  const badgeClass = isRunning ? "badge-running" : isError ? "badge-error" : "badge-done";
  const icon = inferToolIcon(tool.name);
  const fileInfo = extractFileFromTool(tool);

  let formattedArgs = "";
  if (tool.args) {
    if (typeof tool.args === "string") {
      formattedArgs = tool.args;
    } else {
      try {
        formattedArgs = JSON.stringify(tool.args, null, 2);
      } catch {
        formattedArgs = String(tool.args);
      }
    }
  }

  let formattedResult = "";
  if (tool.result !== undefined && tool.result !== null) {
    formattedResult = typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2);
  }

  const detail = extractToolDetail(tool.args);

  return (
    <details class={`tool-line ${isRunning ? "tool-line-running" : ""}`}>
      <summary class="tool-line-header">
        <span class="tool-line-icon" aria-hidden="true">{icon}</span>
        <span class="tool-line-label">{tool.name}</span>
        {detail ? <span class="tool-line-detail" title={detail}>{detail}</span> : null}
        {fileInfo && onOpenArtifact && (
          <button
            type="button"
            class="btn btn-sm btn-open-canvas"
            title="Open in Canvas"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenArtifact({
                id: fileInfo.path,
                title: fileInfo.title,
                filePath: fileInfo.path,
                language: fileInfo.language,
                content: fileInfo.content,
              });
            }}
          >
            Open in Canvas
          </button>
        )}
        <span class={`tool-line-badge ${badgeClass}`}>{badgeText}</span>
      </summary>
      <div class="tool-line-details">
        {formattedArgs ? (
          <>
            <div class="tool-details-header">Parameters:</div>
            <pre class="tool-details-pre">{formattedArgs}</pre>
          </>
        ) : null}
        {formattedResult ? (
          <>
            <div class="tool-details-header" style="margin-top: 8px;">Result:</div>
            <pre class="tool-details-pre tool-result-pre">{formattedResult}</pre>
          </>
        ) : null}
        {fileInfo && onOpenArtifact && (
          <div style="margin-top: 8px;">
            <button
              type="button"
              class="btn btn-sm btn-open-canvas"
              title="Open in Canvas"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenArtifact({
                  id: fileInfo.path,
                  title: fileInfo.title,
                  filePath: fileInfo.path,
                  language: fileInfo.language,
                  content: fileInfo.content,
                });
              }}
            >
              Open in Canvas
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

export function ChatMessageRow({
  message,
  isLastAssistant,
  turnBusy,
  onOpenArtifact,
}: {
  message: ChatMessage;
  isLastAssistant?: boolean;
  turnBusy?: boolean;
  onOpenArtifact?: (artifact: Partial<ArtifactItem> & { title: string; content: string }) => void;
}) {
  const assistant = message.role === "assistant";
  const isStreaming = assistant && Boolean(isLastAssistant && turnBusy);

  return (
    <div class={`message ${assistant ? "message-assistant" : "message-user"}`}>
      <Avatar role={message.role} />
      <div class="message-body">
        {assistant && message.thought ? (
          <ThoughtAccordion thought={message.thought} isStreaming={isStreaming && !message.text} />
        ) : null}
        {assistant && message.toolCalls && message.toolCalls.length > 0 ? (
          <div class="tool-cards-container">
            {message.toolCalls.map((tc, idx) => (
              <ToolCard key={tc.id || idx} tool={tc} onOpenArtifact={onOpenArtifact} />
            ))}
          </div>
        ) : null}
        {message.text ? (
          <div
            class="message-content chat-text chat-markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
          />
        ) : (
          assistant && !message.thought && (!message.toolCalls || message.toolCalls.length === 0) && (
            <span class="chat-thinking">Thinking…</span>
          )
        )}
        {message.error && <div class="chat-turn-error">Error: {message.error}</div>}
        {message.note && <div class="chat-turn-note">{message.note}</div>}
      </div>
    </div>
  );
}

export interface ChatProps {
  chat: ChatTurnController;
  selectedSessionId?: string | null;
  data?: ShellData;
  onOpenArtifact?: (artifact: Partial<ArtifactItem> & { title: string; content: string }) => void;
}

export function Chat({ chat, selectedSessionId, data, onOpenArtifact }: ChatProps) {
  const { state } = chat;
  const busy = isChatBusy(state.status);
  const view = screenState(state);
  const [draft, setDraft] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // When selectedSessionId is passed or changed, call data.loadSession(sessionId) and dispatch loaded messages
  useEffect(() => {
    if (!selectedSessionId || !data?.loadSession) return;
    if (chat.state.sessionId === selectedSessionId && chat.state.messages.length > 0) return;
    let cancelled = false;
    data.loadSession(selectedSessionId).then((res) => {
      if (cancelled || !res) return;
      const messages = Array.isArray(res)
        ? res
        : Array.isArray((res as any).messages)
          ? (res as any).messages
          : reconstructSessionMessages(res);
      if (chat.dispatch) {
        chat.dispatch({ type: "load", sessionId: selectedSessionId, messages });
      } else if (chat.load) {
        chat.load(selectedSessionId, messages);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, data, chat]);

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

  // Delegated click handler for code blocks (Copy + Open in Canvas)
  const handleContainerClick = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest(".btn-copy-code") as HTMLButtonElement | null;
    if (target) {
      const code = target.getAttribute("data-code") || target.closest(".code-block-wrapper")?.querySelector("code")?.textContent || "";
      if (code && navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => {
          target.textContent = "Copied!";
          setTimeout(() => { target.textContent = "Copy"; }, 1500);
        }).catch(() => {});
      }
      return;
    }

    const canvasBtn = (e.target as HTMLElement).closest(".btn-open-canvas") as HTMLButtonElement | null;
    if (canvasBtn && onOpenArtifact) {
      const codeWrapper = canvasBtn.closest(".code-block-wrapper");
      if (codeWrapper) {
        const code = canvasBtn.getAttribute("data-code") || codeWrapper.querySelector("code")?.textContent || "";
        const lang = canvasBtn.getAttribute("data-lang") || "text";
        const title = canvasBtn.getAttribute("data-title") || `Snippet.${lang === "text" ? "txt" : lang}`;
        onOpenArtifact({
          id: title,
          title,
          language: lang,
          content: code,
        });
        return;
      }
    }
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
      <div
        class="chat-container"
        id="messageFeed"
        aria-label="Conversation"
        ref={feedRef}
        onClick={handleContainerClick}
      >
        {state.messages.length === 0 ? (
          <p class="chat-empty" role="status">
            Ask OpenSand to inspect this workspace, run a command or explain a file. The answer streams
            here.
          </p>
        ) : (
          <div class="message-feed" role="list" aria-label="Messages">
            {state.messages.map((m, i) => (
              <ChatMessageRow
                key={i}
                message={m}
                isLastAssistant={m.role === "assistant" && i === state.messages.length - 1}
                turnBusy={busy}
                onOpenArtifact={onOpenArtifact}
              />
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
