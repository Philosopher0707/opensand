import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MessageRecord {
  guid: string;
  text: string;
  handle: string;
  date: string;
  isFromMe: boolean;
}

export interface MessagesOpResult {
  status: "success" | "permission_denied" | "not_supported";
  message?: string;
  messages?: MessageRecord[];
  draft?: {
    recipient: string;
    body: string;
    requiresApproval: boolean;
  };
}

export async function readRecentMessages(limit = 20): Promise<MessagesOpResult> {
  if (process.platform !== "darwin") {
    return {
      status: "not_supported",
      message: "macOS Messages (iMessage/SMS) integration is only available on macOS hosts.",
    };
  }

  const chatDbPath = path.join(os.homedir(), "Library", "Messages", "chat.db");

  // Check if chat.db exists and is accessible
  try {
    await fs.access(chatDbPath, fs.constants.R_OK);
  } catch (err) {
    return {
      status: "permission_denied",
      message: "Access to ~/Library/Messages/chat.db was denied by macOS TCC. To enable, grant Full Disk Access to OpenSand or your terminal in System Settings > Privacy & Security > Full Disk Access.",
    };
  }

  const query = `
    SELECT 
      m.guid,
      m.text,
      COALESCE(h.id, 'unknown') as handle,
      datetime(m.date / 1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as formatted_date,
      m.is_from_me
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.text IS NOT NULL AND trim(m.text) != ''
    ORDER BY m.date DESC
    LIMIT ${Math.min(Math.max(1, limit), 100)};
  `;

  try {
    const { stdout } = await execFileAsync("sqlite3", [
      "-json",
      `file:${chatDbPath}?mode=ro`,
      query,
    ]);

    const rows = stdout ? JSON.parse(stdout) : [];
    const messages: MessageRecord[] = rows.map((r: any) => ({
      guid: String(r.guid || ""),
      text: String(r.text || ""),
      handle: String(r.handle || "unknown"),
      date: String(r.formatted_date || ""),
      isFromMe: Boolean(r.is_from_me),
    }));

    return {
      status: "success",
      messages,
    };
  } catch (err: any) {
    if (err.message && err.message.includes("Operation not permitted")) {
      return {
        status: "permission_denied",
        message: "macOS TCC blocked access to chat.db. Grant Full Disk Access in macOS System Settings.",
      };
    }
    return {
      status: "permission_denied",
      message: `Failed to query Messages database: ${err.message}`,
    };
  }
}

export function draftMessage(recipient: string, body: string): MessagesOpResult {
  return {
    status: "success",
    draft: {
      recipient,
      body,
      requiresApproval: true,
    },
    message: `Draft message prepared for ${recipient}. Sending requires explicit user confirmation.`,
  };
}
