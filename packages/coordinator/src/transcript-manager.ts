import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ChatMessage, ToolCall } from "./types.js";
import { ToolExecutionResult } from "@opensand/local-exec-daemon";

export class TranscriptManager {
  private baseDir: string;
  private sessionId: string;
  private sessionDir: string;

  constructor(sessionId: string, customBaseDir?: string) {
    this.sessionId = sessionId;
    this.baseDir = customBaseDir ?? path.join(os.homedir(), ".opensand", "sessions");
    this.sessionDir = path.join(this.baseDir, this.sessionId);
  }

  get directory(): string {
    return this.sessionDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Append a structured event object to transcript.jsonl.
   */
  async appendJsonl(event: Record<string, any>): Promise<void> {
    await this.ensureDirectory();
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...event,
    }) + "\n";

    await fs.appendFile(path.join(this.sessionDir, "transcript.jsonl"), entry, "utf-8");
  }

  /**
   * Format message history into human-readable Grok Bot transcript parity format.
   */
  formatHumanReadable(messages: ChatMessage[]): string {
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
   * Save messages array directly to messages.json in session directory
   */
  async saveMessages(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    await fs.writeFile(
      path.join(this.sessionDir, "messages.json"),
      JSON.stringify(messages, null, 2),
      "utf-8"
    );
  }

  /**
   * Load messages from disk (preferring messages.json, falling back to transcript.jsonl).
   */
  async loadHistory(): Promise<ChatMessage[]> {
    const messagesPath = path.join(this.sessionDir, "messages.json");
    try {
      const raw = await fs.readFile(messagesPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as ChatMessage[];
      }
    } catch {
      // Fall through to transcript.jsonl
    }

    const jsonlPath = path.join(this.sessionDir, "transcript.jsonl");
    try {
      const raw = await fs.readFile(jsonlPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      let messages: ChatMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.role === "system") {
            if (entry.event === "rollback" && typeof entry.remainingMessages === "number") {
              messages = messages.slice(0, entry.remainingMessages);
            } else if (entry.event === "compacted" && entry.content) {
              messages = [
                { role: "system", content: entry.content },
                ...messages.filter((m) => m.role !== "system"),
              ];
            } else if (entry.content) {
              messages.push({ role: "system", content: entry.content });
            }
          } else if (entry.role === "user") {
            messages.push({
              role: "user",
              content: entry.content ?? null,
            });
          } else if (entry.role === "assistant") {
            messages.push({
              role: "assistant",
              content: entry.content ?? null,
              tool_calls: entry.tool_calls,
            });
          } else if (entry.role === "tool") {
            const content =
              entry.content ??
              (typeof entry.result === "string"
                ? entry.result
                : JSON.stringify(entry.result ?? ""));
            messages.push({
              role: "tool",
              tool_call_id: entry.tool_call_id,
              content,
            });
          }
        } catch {
          // Ignore invalid line
        }
      }
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Save formatted transcript.txt and messages.json to disk.
   */
  async writeHumanReadableTranscript(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    const formatted = this.formatHumanReadable(messages);
    await fs.writeFile(path.join(this.sessionDir, "transcript.txt"), formatted, "utf-8");
    await this.saveMessages(messages);
  }
}
