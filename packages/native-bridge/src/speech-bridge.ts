import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SpeechResult {
  status: "success" | "error" | "not_supported";
  message?: string;
  voiceUsed?: string;
}

export async function speakText(text: string, voice?: string, rate?: number): Promise<SpeechResult> {
  if (process.platform !== "darwin") {
    return {
      status: "not_supported",
      message: "Speech synthesis via native Apple TTS is only supported on macOS.",
    };
  }

  const args: string[] = [];
  if (voice) {
    args.push("-v", voice);
  }
  if (rate) {
    args.push("-r", String(rate));
  }
  args.push(text.slice(0, 1000)); // Cap length

  try {
    await execFileAsync("say", args, { timeout: 15000 });
    return {
      status: "success",
      voiceUsed: voice || "default",
    };
  } catch (err: any) {
    return {
      status: "error",
      message: `Failed to speak text: ${err.message}`,
    };
  }
}
