// packages/desktop/renderer-next/src/views/Chat.tsx
// Chat view: message feed, markdown rendering, collapsible thought accordions,
// structured tool execution cards, status announcement and prompt composer.

import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { ShellData } from "../data";
import { parseAnsi, type AnsiSpan } from "../../../src/shell/chat-ansi";
import {
  INITIAL_CHAT_TURN,
  chatEventAction,
  chatTurnReducer,
  canRetryTurn,
  formatElapsed,
  isBlankAssistantTurn,
  isChatBusy,
  rateLimitRetryLabel,
  reconstructSessionMessages,
  retryLabel,
  type ChatMessage,
  type ChatTurnAction,
  type ChatTurnState,
  type ToolCallItem,
} from "../../../src/shell/chat-turn-model";
import type { ArtifactItem } from "../../../src/shell/canvas-model";
import type { TurnEvent } from "../../../src/shell/quick-capture-model";
import { querySendArgs } from "../../../src/shell/query-send-model";
import { renderMarkdown } from "./chat-markdown";
import {
  DEFAULT_PROMPT_CHIPS,
  DEFAULT_SLASH_COMMANDS,
  applyPromptChip,
  composePromptWithAttachments,
  detectTrigger,
  filterSlashCommands,
  formatBytes,
  friendlyErrorMessage,
  getFileCategory,
  insertTriggerSelection,
  previewErrorMessage,
  runLocalSlashCommand,
  type PromptChip,
  type SlashCommand,
  type StagedAttachment,
  type TriggerMatch,
} from "../../../src/shell/composer-model";

const TRANSCRIPT_LOAD_ERROR = "Could not load this conversation's history. Select the session again to retry.";

export interface ChatTurnController {
  state: ChatTurnState;
  available: boolean;
  send: (query: string) => void;
  stop: () => void;
  load?: (sessionId: string, messages: ChatMessage[]) => void;
  dispatch?: (action: ChatTurnAction) => void;
  loadError?: string | null;
  clearLoadError?: () => void;
}

export function useChatTurn(
  data: ShellData,
  selectedSessionId?: string | null,
  activeAgentId?: string | null,
): ChatTurnController {
  const available = typeof data.sendQuery === "function";
  const [loadError, setLoadError] = useState<string | null>(null);
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
    if (!selectedSessionId) {
      dispatch({ type: "load", sessionId: "", messages: [] });
      return;
    }
    if (!data.loadSession) return;
    let cancelled = false;
    setLoadError(null);
    data.loadSession(selectedSessionId).then((res) => {
      if (cancelled || !res) return;
      const messages = Array.isArray(res)
        ? res
        : Array.isArray((res as any).messages)
          ? (res as any).messages
          : reconstructSessionMessages(res);
      dispatch({ type: "load", sessionId: selectedSessionId, messages });
    }).catch((err) => {
      if (!cancelled) setLoadError(friendlyErrorMessage(err, TRANSCRIPT_LOAD_ERROR));
    });
    return () => {
      cancelled = true;
    };
  }, [data, selectedSessionId]);

  const send = (query: string) => {
    const text = query.trim();
    if (!data.sendQuery || !text || isChatBusy(stateRef.current.status)) return;
    dispatch({ type: "start", query: text });
    data.sendQuery(...querySendArgs(text, selectedSessionId, activeAgentId)).then(
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

  return { state, available, send, stop, load, dispatch, loadError, clearLoadError: () => setLoadError(null) };
}

function statusText(state: ChatTurnState, now: number = Date.now()): string {
  const rateLimitText = rateLimitRetryLabel(state.retry, now);
  if (rateLimitText) return rateLimitText;
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

/** Renders parsed SGR spans as text and styles; never as HTML. */
export function AnsiText({ spans }: { spans: AnsiSpan[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <span
          key={i}
          style={{
            color: span.color,
            backgroundColor: span.background,
            fontWeight: span.bold ? 700 : undefined,
          }}
        >
          {span.text}
        </span>
      ))}
    </>
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
            <pre class="tool-details-pre"><AnsiText spans={parseAnsi(formattedArgs)} /></pre>
          </>
        ) : null}
        {formattedResult ? (
          <>
            <div class="tool-details-header" style="margin-top: 8px;">Result:</div>
            <pre class="tool-details-pre tool-result-pre"><AnsiText spans={parseAnsi(formattedResult)} /></pre>
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
        {message.error && <div class="chat-turn-error">{message.error}</div>}
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
  const hideBlankEnd = state.status === "stopped" && isBlankAssistantTurn(state);
  const [draft, setDraft] = useState("");
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const timerRunning = isChatBusy(state.status);

  // One interval per turn: cleanup runs on done, error, stop and unmount, so none is leaked.
  // The same tick also drives the rate-limit countdown while the wait is visible.
  useEffect(() => {
    if (!timerRunning) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = () => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
      setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timerRunning]);

  // Autocomplete / Slash trigger state
  const [triggerMatch, setTriggerMatch] = useState<TriggerMatch | null>(null);
  const [triggerActiveIndex, setTriggerActiveIndex] = useState(0);
  const [triggerItems, setTriggerItems] = useState<SlashCommand[]>([]);

  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Dismiss trigger popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        e.target !== inputRef.current
      ) {
        setTriggerMatch(null);
        setTriggerItems([]);
      }
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, []);

  const addFilesToStaged = async (files: File[]) => {
    if (!files || files.length === 0) return;
    const newItems: StagedAttachment[] = [];
    for (const f of files) {
      const isImg = f.type ? f.type.startsWith("image/") : /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name);
      let previewUrl: string | null = null;
      if (isImg && typeof URL !== "undefined" && URL.createObjectURL) {
        try {
          previewUrl = URL.createObjectURL(f);
        } catch {
          setNotice(previewErrorMessage(f.name));
        }
      }
      const item: StagedAttachment = {
        name: f.name,
        size: f.size,
        type: f.type || "application/octet-stream",
        localPath: (f as any).path || f.name,
        previewUrl,
        serverId: null,
      };
      if (data?.stageAttachment) {
        try {
          const res = await data.stageAttachment(item.localPath || item.name);
          if (res && res.id) item.serverId = res.id;
        } catch (err) {
          setNotice(friendlyErrorMessage(err, `Could not attach ${f.name}. Check the file and try again.`));
        }
      }
      newItems.push(item);
    }
    setStagedAttachments((prev) => [...prev, ...newItems]);
  };

  const removeAttachment = (index: number) => {
    setStagedAttachments((prev) => {
      const next = [...prev];
      const removed = next.splice(index, 1)[0];
      if (removed?.previewUrl && typeof URL !== "undefined" && URL.revokeObjectURL) {
        // Cleanup only: a failed revoke leaves no state behind, so there is nothing to report.
        try { URL.revokeObjectURL(removed.previewUrl); } catch {}
      }
      if (removed?.serverId && data?.deleteAttachment) {
        data.deleteAttachment(removed.serverId).catch(() => {});
      }
      return next;
    });
  };

  const updateTriggerSuggestions = (text: string, caretPos: number) => {
    const match = detectTrigger(text, caretPos);
    if (!match) {
      setTriggerMatch(null);
      setTriggerItems([]);
      setTriggerActiveIndex(0);
      return;
    }
    setTriggerMatch(match);
    if (match.triggerChar === "/") {
      const filtered = filterSlashCommands(DEFAULT_SLASH_COMMANDS, match.query);
      setTriggerItems(filtered);
      setTriggerActiveIndex(0);
    } else {
      setTriggerItems([]);
      setTriggerActiveIndex(0);
    }
  };

  const selectTriggerSuggestion = (item: SlashCommand) => {
    if (!triggerMatch || !inputRef.current) return;
    const caret = inputRef.current.selectionStart || draft.length;
    const { newText, newCaretPos } = insertTriggerSelection(
      draft,
      triggerMatch.startPos,
      caret,
      item.title
    );
    setDraft(newText);
    setTriggerMatch(null);
    setTriggerItems([]);
    setTriggerActiveIndex(0);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCaretPos, newCaretPos);
      }
    }, 0);
  };

  // When selectedSessionId is passed or changed, call data.loadSession(sessionId) and dispatch loaded messages
  useEffect(() => {
    if (!selectedSessionId || !data?.loadSession) return;
    if (chat.state.sessionId === selectedSessionId && chat.state.messages.length > 0) return;
    let cancelled = false;
    setLoadError(null);
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
    }).catch((err) => {
      if (!cancelled) setLoadError(friendlyErrorMessage(err, TRANSCRIPT_LOAD_ERROR));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, data, chat, reloadKey]);

  // Follow the stream, as the transcript grows on every token.
  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [state.messages]);

  const clearComposer = () => {
    setDraft("");
    setStagedAttachments([]);
    setTriggerMatch(null);
    setTriggerItems([]);
    if (inputRef.current) inputRef.current.style.height = "auto";
  };

  const submit = () => {
    if (busy || (!draft.trim() && stagedAttachments.length === 0)) return;
    const local = runLocalSlashCommand(draft.trim(), {
      compact: data?.compact,
      rollback: data?.rollback,
      clearView: () => {
        if (chat.dispatch) chat.dispatch({ type: "load", sessionId: "", messages: [] });
        else chat.load?.("", []);
      },
      hasSession: Boolean(selectedSessionId),
      notice: setNotice,
    });
    if (local !== false) {
      local.then(clearComposer);
      return;
    }
    const finalPrompt = composePromptWithAttachments(draft, stagedAttachments);
    if (!finalPrompt) return;
    setNotice(null);
    chat.send(finalPrompt);
    clearComposer();
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
            {state.messages.map((m, i) =>
              hideBlankEnd && i === state.messages.length - 1 ? null : (
                <ChatMessageRow
                  key={i}
                  message={m}
                  isLastAssistant={m.role === "assistant" && i === state.messages.length - 1}
                  turnBusy={busy}
                  onOpenArtifact={onOpenArtifact}
                />
              )
            )}
          </div>
        )}
      </div>
      {/* Always mounted, so the first status change is announced. */}
      <div class="chat-status" role="status" aria-live="polite" data-status={state.status} data-elapsed={elapsed}>
        <span>{statusText(state, now)}</span>
        {timerRunning && !state.retry && <span class="chat-elapsed" aria-hidden="true"> {formatElapsed(elapsed)}</span>}
        {notice && <div class="chat-turn-note" data-kind="notice">{notice}</div>}
        {(chat.loadError || loadError) && (
          <div class="chat-turn-error" role="alert">
            {chat.loadError || loadError}
            <button
              type="button"
              class="btn btn-sm chat-retry"
              onClick={() => {
                setLoadError(null);
                chat.clearLoadError?.();
                setReloadKey((key) => key + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}
        {canRetryTurn(state) && (
          <button type="button" class="btn btn-sm chat-retry" onClick={retry}>
            {retryLabel(state.status)}
          </button>
        )}
      </div>
      <footer class="input-panel">
        <div class="prompt-chips-strip" role="toolbar" aria-label="Quick prompts">
          {DEFAULT_PROMPT_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              class="prompt-chip"
              data-query={chip.query}
              title={chip.desc}
              onClick={() => {
                setDraft((prev) => applyPromptChip(prev, chip.query));
                if (inputRef.current) inputRef.current.focus();
              }}
            >
              {chip.icon && <span class="prompt-chip-icon" aria-hidden="true">{chip.icon}</span>}
              <span class="prompt-chip-title">{chip.title}</span>
            </button>
          ))}
        </div>

        <div
          class={`input-wrapper ${isDragOver ? "drag-over" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setIsDragOver(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              addFilesToStaged(Array.from(e.dataTransfer.files));
            }
          }}
        >
          {/* Autocomplete Trigger Popover */}
          {triggerMatch && triggerItems.length > 0 && (
            <div
              id="triggerPopover"
              ref={popoverRef}
              class="trigger-popover"
              role="listbox"
              aria-label="Suggestions"
            >
              <div class="trigger-popover-header">
                {triggerMatch.triggerChar === "/" ? "Skills & Slash Commands" : "Suggestions"}
              </div>
              {triggerItems.map((item, idx) => (
                <div
                  key={item.title}
                  role="option"
                  aria-selected={idx === triggerActiveIndex}
                  class={`trigger-item ${idx === triggerActiveIndex ? "active" : ""}`}
                  onClick={() => selectTriggerSuggestion(item)}
                  onMouseEnter={() => setTriggerActiveIndex(idx)}
                >
                  <span class="trigger-item-icon" aria-hidden="true">{item.icon}</span>
                  <div class="trigger-item-meta">
                    <span class="trigger-item-title">{item.title}</span>
                    <span class="trigger-item-desc">{item.desc}</span>
                  </div>
                  <span class="trigger-item-tag">{item.tag}</span>
                </div>
              ))}
            </div>
          )}

          {/* Staged Attachments Strip */}
          {stagedAttachments.length > 0 && (
            <div id="attachmentStrip" class="attachment-strip" role="list" aria-label="Staged Attachments">
              {stagedAttachments.map((att, idx) => {
                const cat = getFileCategory(att.name, att.type);
                return (
                  <div key={idx} class="attachment-chip" role="listitem">
                    {att.previewUrl ? (
                      <img src={att.previewUrl} class="attachment-thumb" alt={att.name} />
                    ) : (
                      <span class="attachment-chip-icon" aria-hidden="true">
                        {cat === "image" ? "🖼️" : cat === "code" ? "📄" : "📎"}
                      </span>
                    )}
                    <div class="attachment-chip-meta">
                      <span class="attachment-chip-name" title={att.name}>{att.name}</span>
                      <span class="attachment-chip-size">{formatBytes(att.size)}</span>
                    </div>
                    <button
                      type="button"
                      class="btn-remove-attachment"
                      title="Remove attachment"
                      aria-label={`Remove ${att.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeAttachment(idx);
                      }}
                    >
                      &times;
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div class="input-textarea-row">
            <textarea
              id="promptInput"
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder="Ask OpenSand…   / skills   ·   @ bots   ·   # files"
              aria-label="Message OpenSand"
              disabled={!chat.available}
              onInput={(e) => {
                const el = e.target as HTMLTextAreaElement;
                setDraft(el.value);
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
                updateTriggerSuggestions(el.value, el.selectionStart || el.value.length);
              }}
              onKeyDown={(e) => {
                if (triggerMatch && triggerItems.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setTriggerActiveIndex((prev) => (prev + 1) % triggerItems.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setTriggerActiveIndex((prev) => (prev - 1 + triggerItems.length) % triggerItems.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    selectTriggerSuggestion(triggerItems[triggerActiveIndex]);
                    return;
                  }
                  if (e.key === "Escape" || e.key === "Esc") {
                    e.preventDefault();
                    setTriggerMatch(null);
                    setTriggerItems([]);
                    return;
                  }
                }
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
              <button
                id="btnAttachFile"
                class="btn-attach"
                type="button"
                title="Attach file or screenshot"
                onClick={() => fileInputRef.current?.click()}
              >
                <span aria-hidden="true">📎</span> <span>Attach</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                id="fileAttachmentInput"
                class="hidden"
                multiple
                onChange={(e) => {
                  const files = Array.from((e.target as HTMLInputElement).files || []);
                  if (files.length > 0) addFilesToStaged(files);
                  (e.target as HTMLInputElement).value = "";
                }}
              />
              <span class="badge badge-model">Local agent</span>
            </div>
            <div class="input-actions-right">
              <button
                id="btnSend"
                type="button"
                class="btn btn-primary btn-sm"
                disabled={busy || !chat.available || (!draft.trim() && stagedAttachments.length === 0)}
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
