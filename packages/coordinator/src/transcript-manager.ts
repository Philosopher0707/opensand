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
   * Save formatted transcript.txt to disk.
   */
  async writeHumanReadableTranscript(messages: ChatMessage[]): Promise<void> {
    await this.ensureDirectory();
    const formatted = this.formatHumanReadable(messages);
    await fs.writeFile(path.join(this.sessionDir, "transcript.txt"), formatted, "utf-8");
  }
}
