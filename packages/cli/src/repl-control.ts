import { classifyError } from "@opensand/coordinator";

export interface ClientCommandResult {
  message: string;
  model?: string;
  endpoint?: string;
}

/** Two plain-language lines: what happened, then what to do. Never echoes the API key. */
export function formatTurnError(err: unknown, apiKey?: string): string {
  const actionable = classifyError(err);
  const text = `${actionable.cause}\n${actionable.nextAction}`;
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

function isValidEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Returns null when the line is not a client-switching command. */
export function clientCommandResult(
  line: string,
  current: { model: string; endpoint: string }
): ClientCommandResult | null {
  if (line === "/model") {
    return { message: `Current model: ${current.model}` };
  }
  if (line.startsWith("/model ")) {
    const model = line.slice(7).trim();
    return model ? { message: `Model switched to: ${model}`, model } : { message: "Usage: /model <name>" };
  }
  if (line.startsWith("/endpoint ")) {
    const endpoint = line.slice(10).trim();
    return isValidEndpoint(endpoint)
      ? { message: `Endpoint switched to: ${endpoint}`, endpoint }
      : { message: "Invalid endpoint. Use a full http:// or https:// URL, e.g. http://127.0.0.1:11434/v1" };
  }
  return null;
}
