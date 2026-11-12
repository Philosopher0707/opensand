import type { SessionEvent } from "@opensand/shared";
import type { ChatMessage, SessionMetadata } from "./types.js";

export const EVENT = {
  sessionCreated: "session.created",
  snapshot: "session.snapshot",
  system: "session.system",
  turnStarted: "turn.started",
  turnFolded: "turn.folded",
  turnRollback: "turn.rollback",
  turnCompacted: "turn.compacted",
  modelCompletion: "model.completion",
  toolCompleted: "tool.completed",
  restorePoint: "workspace.restorePoint",
  restorePointFailed: "workspace.restorePointFailed",
  restore: "workspace.restore",
} as const;

const LEGACY_EVENT_NAMES: Record<string, string | undefined> = {
  [EVENT.restorePoint]: "restore_point",
  [EVENT.restorePointFailed]: "restore_point_failed",
  [EVENT.restore]: "restore",
};

export interface FoldChange {
  index: number;
  message: ChatMessage;
}

export function projectMessages(events: SessionEvent[]): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const event of events) {
    const data = event.data;
    switch (event.kind) {
      case EVENT.snapshot:
        messages = [...(data.messages as ChatMessage[])];
        break;
      case EVENT.system: {
        const system: ChatMessage = { role: "system", content: data.content };
        if (messages[0]?.role === "system") {
          messages[0] = system;
        } else {
          messages.unshift(system);
        }
        break;
      }
      case EVENT.turnStarted:
      case EVENT.modelCompletion:
      case EVENT.toolCompleted:
        messages.push(data.message as ChatMessage);
        break;
      case EVENT.turnFolded:
        for (const change of data.changes as FoldChange[]) {
          messages[change.index] = change.message;
        }
        break;
      case EVENT.turnRollback:
        messages = messages.slice(0, data.keepLength);
        break;
      case EVENT.turnCompacted:
        messages = [
          messages[0],
          { role: "system", content: data.summary },
          ...messages.slice(data.keepFrom),
        ];
        break;
    }
  }
  return messages;
}

export function formatHumanReadable(messages: ChatMessage[]): string {
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

export function projectTranscriptText(events: SessionEvent[]): string {
  return formatHumanReadable(projectMessages(events));
}

export function projectTranscriptJsonl(events: SessionEvent[]): string {
  const lines: string[] = [];
  const pushEntry = (ev: SessionEvent, message: ChatMessage) => {
    if (message.role === "system") return;
    lines.push(JSON.stringify({ timestamp: ev.ts, sessionId: ev.sessionId, ...message }) + "\n");
  };

  for (const ev of events) {
    if (ev.kind === EVENT.snapshot) {
      for (const message of ev.data.messages as ChatMessage[]) pushEntry(ev, message);
    } else if (ev.kind === EVENT.turnStarted || ev.kind === EVENT.modelCompletion || ev.kind === EVENT.toolCompleted) {
      pushEntry(ev, ev.data.message as ChatMessage);
    } else if (LEGACY_EVENT_NAMES[ev.kind]) {
      lines.push(JSON.stringify({ timestamp: ev.ts, sessionId: ev.sessionId, event: LEGACY_EVENT_NAMES[ev.kind], ...ev.data }) + "\n");
    }
  }
  return lines.join("");
}

export function projectMetadata(events: SessionEvent[]): SessionMetadata {
  const first = events[0];
  const last = events[events.length - 1];
  const created = [...events].reverse().find((ev) => ev.kind === EVENT.sessionCreated)?.data ?? {};
  const firstQuery = events.find((ev) => ev.kind === EVENT.turnStarted)?.data.message.content;

  return {
    sessionId: first?.sessionId ?? "",
    createdAt: first?.ts ?? "",
    updatedAt: last?.ts ?? "",
    model: created.model ?? "",
    endpoint: "",
    title: typeof firstQuery === "string" ? firstQuery.slice(0, 80) : undefined,
  };
}
