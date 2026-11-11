import { SessionEvent } from "@opensand/shared";
import { ChatMessage, SessionMetadata } from "./types.js";
import { reconcileTurnInvariants } from "./transcript-manager.js";

/**
 * Recreates ChatMessage[] history deterministically from an append-only event log.
 */
export function projectMessages(
  events: SessionEvent[],
  options?: { strategy?: "stub" | "prune" }
): ChatMessage[] {
  let messages: ChatMessage[] = [];

  for (const ev of events) {
    const data = ev.data ?? {};

    // 1. Rollback event
    if (ev.kind === "turn.rollback" || (data.role === "system" && data.event === "rollback")) {
      const remaining = typeof data.remainingMessages === "number" ? data.remainingMessages : undefined;
      if (remaining !== undefined) {
        messages = messages.slice(0, remaining);
      }
      continue;
    }

    // 2. Compacted event
    if (ev.kind === "turn.compacted" || (data.role === "system" && data.event === "compacted")) {
      const summaryContent = data.content ?? data.compactedSummary;
      if (summaryContent) {
        messages = [
          { role: "system", content: summaryContent },
          ...messages.filter((m) => m.role !== "system"),
        ];
      }
      continue;
    }

    // 3. User message / turn.started
    if (ev.kind === "turn.started" || ev.kind === "user.message" || data.role === "user") {
      messages.push({
        role: "user",
        content: data.content ?? null,
      });
      continue;
    }

    // 4. Assistant message / model.completion
    if (ev.kind === "model.completion" || ev.kind === "assistant.message" || data.role === "assistant") {
      messages.push({
        role: "assistant",
        content: data.content ?? null,
        tool_calls: data.tool_calls,
      });
      continue;
    }

    // 5. Tool response / tool.completed / tool.failed
    if (ev.kind === "tool.completed" || ev.kind === "tool.failed" || data.role === "tool") {
      const content =
        data.content ??
        (typeof data.result === "string"
          ? data.result
          : JSON.stringify(data.result ?? ""));
      messages.push({
        role: "tool",
        tool_call_id: data.tool_call_id ?? data.toolCallId,
        content,
      });
      continue;
    }

    // 6. Generic system message
    if (ev.kind === "session.system" || data.role === "system") {
      if (data.content) {
        messages.push({
          role: "system",
          content: data.content,
        });
      }
      continue;
    }
  }

  const reconciled = reconcileTurnInvariants(messages, { strategy: options?.strategy });
  return reconciled.messages;
}

/**
 * Computes SessionMetadata (title, timestamps, turn count, model, endpoint) from the event log.
 */
export function projectMetadata(events: SessionEvent[]): SessionMetadata {
  const sessionId = events[0]?.sessionId ?? "";
  const createdAt = events[0]?.ts ?? new Date().toISOString();
  const updatedAt = events[events.length - 1]?.ts ?? createdAt;

  let title: string | undefined;
  let model: string = "default";
  let endpoint: string = "";
  let provider: string | undefined;
  let agentId: string | undefined;
  let roomId: string | undefined;
  let turnCount = 0;

  for (const ev of events) {
    const data = ev.data ?? {};

    if (ev.kind === "session.created") {
      if (data.title) title = data.title;
      if (data.model) model = data.model;
      if (data.endpoint) endpoint = data.endpoint;
      if (data.provider) provider = data.provider;
      if (data.agentId) agentId = data.agentId;
      if (data.roomId) roomId = data.roomId;
    } else if (ev.kind === "session.renamed") {
      if (data.title) title = data.title;
    }

    if (ev.kind === "turn.started" || ev.kind === "user.message" || data.role === "user") {
      turnCount++;
      if (title === undefined && typeof data.content === "string") {
        title = data.content.slice(0, 80);
      }
    }

    if (data.model && model === "default") {
      model = data.model;
    }
  }

  return {
    sessionId,
    createdAt,
    updatedAt,
    model,
    endpoint,
    provider,
    title,
    agentId,
    roomId,
    turnCount,
  };
}

/**
 * Generates formatted human-readable transcript parity format from events.
 */
export function projectHumanReadable(events: SessionEvent[]): string {
  const messages = projectMessages(events);
  const sections: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      continue;
    }

    if (msg.role === "user") {
      sections.push(`<user_query>\n${msg.content ?? ""}\n</user_query>`);
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.content) {
        sections.push(`assistant:\n${msg.content}`);
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          sections.push(`[Tool call]\nTool: ${tc.function.name}\nArguments: ${tc.function.arguments}`);
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      sections.push(`[Tool result]\n${msg.content ?? ""}`);
      continue;
    }
  }

  return sections.join("\n\n") + "\n";
}

/**
 * Generates transcript.jsonl entries for backwards compatibility with tools expecting the legacy format.
 */
export function projectTranscriptJsonl(events: SessionEvent[]): string {
  const lines: string[] = [];

  for (const ev of events) {
    const data = ev.data ?? {};
    if (data.role) {
      lines.push(
        JSON.stringify({
          timestamp: ev.ts,
          sessionId: ev.sessionId,
          ...data,
        })
      );
    } else if (ev.kind === "turn.started" || ev.kind === "user.message") {
      lines.push(
        JSON.stringify({
          timestamp: ev.ts,
          sessionId: ev.sessionId,
          role: "user",
          content: data.content ?? null,
        })
      );
    } else if (ev.kind === "model.completion" || ev.kind === "assistant.message") {
      lines.push(
        JSON.stringify({
          timestamp: ev.ts,
          sessionId: ev.sessionId,
          role: "assistant",
          content: data.content ?? null,
          tool_calls: data.tool_calls,
        })
      );
    } else if (ev.kind === "tool.completed" || ev.kind === "tool.failed") {
      lines.push(
        JSON.stringify({
          timestamp: ev.ts,
          sessionId: ev.sessionId,
          role: "tool",
          tool_call_id: data.tool_call_id ?? data.toolCallId,
          result: data.result ?? data.content,
        })
      );
    } else {
      lines.push(
        JSON.stringify({
          timestamp: ev.ts,
          sessionId: ev.sessionId,
          kind: ev.kind,
          ...data,
        })
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}
