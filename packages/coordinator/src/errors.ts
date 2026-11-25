/**
 * Error Taxonomy for OpenSand
 * Maps provider, daemon, gate, and OS errors to user-actionable causes and next steps.
 * Prevents raw stack traces in the UI.
 */

/**
 * Engine-agnostic sign-in failure test, shared by the display layer and the engine fallback.
 * Covers Claude's "is not signed in", OpenCode's "provider authentication required" and
 * the other engines' wording from engine_facts.mjs; a single display sentence is not enough.
 */
export function isAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || "");
  return /is not signed in|has no working sign-in|provider authentication required|not logged in|log ?in|authenticat|unauthori[sz]ed|401|invalid api key|credentials/i.test(msg);
}

export interface ActionableError {
  code: string;
  cause: string;
  nextAction: string;
  isUserFixable: boolean;
  statusCode?: number;
  rawMessage?: string;
  retryAfterMs?: number;
}

export function classifyError(err: unknown): ActionableError {
  const msg = err instanceof Error ? err.message : String(err || "");
  const lower = msg.toLowerCase();
  const status = (err as any)?.status || (err as any)?.statusCode;
  const retryAfterMs = (err as any)?.retryAfterMs;
  const upstreamDetail = (err as any)?.upstreamDetail || "";
  const detailLower = typeof upstreamDetail === "string" ? upstreamDetail.toLowerCase() : "";

  // 1. Rate Limits & Quotas (429)
  if (status === 429 || lower.includes("429") || lower.includes("rate limit") || lower.includes("quota exceeded")) {
    // A reset far in the future is a daily quota: waiting in this turn cannot help.
    const resetAt = (err as any)?.resetAt;
    if (typeof resetAt === "number" && resetAt > Date.now()) {
      const when = new Date(resetAt).toLocaleTimeString();
      const farAway = resetAt - Date.now() > 5 * 60_000;
      return {
        code: "RATE_LIMIT_EXCEEDED",
        cause: `The model provider's rate limit resets at ${when}.`,
        nextAction: farAway
          ? "Switch to another model in Settings to keep working."
          : "Wait for the reset, or switch to another model in Settings.",
        isUserFixable: true,
        statusCode: 429,
        rawMessage: msg,
        retryAfterMs: resetAt - Date.now(),
      };
    }
    const isProviderReturnedError =
      detailLower.includes("provider returned error") ||
      lower.includes("provider returned error");
    const retrySecs =
      typeof retryAfterMs === "number" && retryAfterMs > 0
        ? Math.ceil(retryAfterMs / 1000)
        : undefined;
    const waitPart = retrySecs
      ? `Wait ${retrySecs}s before retrying`
      : isProviderReturnedError
        ? "Wait a few moments before retrying"
        : "Wait a few moments before trying again";

    if (isProviderReturnedError) {
      return {
        code: "RATE_LIMIT_EXCEEDED",
        cause: "The upstream model provider is rate-limited or the model's daily limit was reached.",
        nextAction: `${waitPart}, or switch to another model in Settings.`,
        isUserFixable: true,
        statusCode: 429,
        rawMessage: msg,
        retryAfterMs,
      };
    }

    return {
      code: "RATE_LIMIT_EXCEEDED",
      cause: "You exceeded the model provider rate limit or token quota.",
      nextAction: `${waitPart}, or switch to another model in Settings.`,
      isUserFixable: true,
      statusCode: 429,
      rawMessage: msg,
      retryAfterMs,
    };
  }

  // 2. Insufficient Credits / Payment Required (402)
  if (
    status === 402 ||
    lower.includes("402") ||
    lower.includes("insufficient credits") ||
    lower.includes("payment required")
  ) {
    return {
      code: "INSUFFICIENT_CREDITS",
      cause: "Your model provider account ran out of credits or requires payment.",
      nextAction: "Add credits in your provider dashboard, or switch to another model in Settings.",
      isUserFixable: true,
      statusCode: 402,
      rawMessage: msg,
    };
  }

  // 3. Authentication & API keys (401 / 403)
  if (
    status === 401 ||
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid_api_key")
  ) {
    return {
      code: "AUTH_INVALID_KEY",
      cause: "The model provider rejected your API key.",
      nextAction: "Check or re-enter your API key in Settings.",
      isUserFixable: true,
      statusCode: 401,
      rawMessage: msg,
    };
  }

  if (
    status === 403 ||
    lower.includes("403") ||
    lower.includes("access forbidden") ||
    lower.includes("forbidden")
  ) {
    return {
      code: "AUTH_FORBIDDEN",
      cause: "Access forbidden. Your account or API key does not have permission for this model.",
      nextAction: "Check your API key permissions and model access in Settings.",
      isUserFixable: true,
      statusCode: 403,
      rawMessage: msg,
    };
  }

  // 4. Model or Endpoint Not Found (404)
  if (
    status === 404 ||
    lower.includes("404") ||
    (lower.includes("not found") && (lower.includes("model") || lower.includes("endpoint")))
  ) {
    return {
      code: "MODEL_NOT_FOUND",
      cause: "The requested model or endpoint was not found.",
      nextAction: "Check your model name and endpoint in Settings.",
      isUserFixable: true,
      statusCode: 404,
      rawMessage: msg,
    };
  }

  // 5. Provider Downtime & Server Errors (500, 502, 503, 504, 5xx)
  if (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    status === 500 ||
    (typeof status === "number" && status >= 500 && status < 600) ||
    lower.includes("overloaded") ||
    lower.includes("service unavailable")
  ) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      cause: "The model provider is temporarily overloaded or down for maintenance.",
      nextAction: "Try again in a few minutes, or switch to another model in Settings.",
      isUserFixable: false,
      statusCode: status || 503,
      rawMessage: msg,
    };
  }

  // 6. Local Ollama unreachable
  if (lower.includes("econnrefused 127.0.0.1:11434") || (lower.includes("ollama") && lower.includes("connect"))) {
    return {
      code: "OLLAMA_UNREACHABLE",
      cause: "Local Ollama service is not running or not listening on port 11434.",
      nextAction: "Start Ollama from your Applications menu or run `ollama serve` in a terminal.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 7. Network connectivity
  if (
    lower.includes("enotfound") ||
    lower.includes("getaddrinfo") ||
    lower.includes("network offline") ||
    lower.includes("econnreset") ||
    lower.includes("enetunreach") ||
    lower.includes("ehostunreach") ||
    (err as any)?.code === "ECONNRESET" ||
    (err as any)?.code === "ENOTFOUND" ||
    (err as any)?.isNetworkError
  ) {
    return {
      code: "NETWORK_OFFLINE",
      cause: "Could not connect to the remote server.",
      nextAction: "Check your internet connection and proxy settings.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 8. Command / connection timeout
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    (err as any)?.code === "ETIMEDOUT"
  ) {
    return {
      code: "EXECUTION_TIMEOUT",
      cause: "The operation or connection to the model provider timed out.",
      nextAction: "Check your network connection, or try a smaller prompt or faster model in Settings.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 9. Action / Tool denied by user
  if (
    lower.includes("permission_denied") ||
    lower.includes("approval rejected") ||
    lower.includes("denied by user") ||
    lower.includes("tool rejected")
  ) {
    return {
      code: "TOOL_APPROVAL_DENIED",
      cause: "The tool execution was denied by policy or user approval.",
      nextAction: "Rephrase your request or click Approve on the permission card if you want to allow it.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 10. File Not Found (ENOENT)
  if (lower.includes("enoent") || lower.includes("no such file or directory")) {
    return {
      code: "FILE_NOT_FOUND",
      cause: "The requested file or directory does not exist.",
      nextAction: "Verify the file path exists in your workspace.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 11. OS Permission Denied (EACCES / EPERM)
  if (lower.includes("eacces") || lower.includes("eperm") || lower.includes("permission denied")) {
    return {
      code: "FS_PERMISSION_DENIED",
      cause: "Operating system denied permission to read or write the file.",
      nextAction: "Check filesystem permissions for the target folder.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 12. Disk Full (ENOSPC)
  if (lower.includes("enospc") || lower.includes("no space left on device")) {
    return {
      code: "DISK_FULL",
      cause: "Your disk has run out of free space.",
      nextAction: "Free up disk space on your drive and retry.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 13. Context window exceeded
  if (lower.includes("context length") || lower.includes("maximum context") || lower.includes("prompt too long")) {
    return {
      code: "CONTEXT_LENGTH_EXCEEDED",
      cause: "The conversation context exceeds the model maximum token limit.",
      nextAction: "Start a new session or compact history using the Compact button.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 14. State migration downgrade
  if (lower.includes("downgrade") || lower.includes("newer version of opensand")) {
    return {
      code: "STATE_DOWNGRADE_REFUSED",
      cause: "Your state files were created by a newer version of OpenSand.",
      nextAction: "Update OpenSand to the latest version to access this state.",
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // Default fallback
  return {
    code: "UNKNOWN_ERROR",
    cause: msg || "An unexpected error occurred during execution.",
    nextAction: "Try re-running your request or check logs for diagnostics.",
    isUserFixable: false,
    rawMessage: msg,
  };
}

export function formatUserErrorMessage(actionable: ActionableError): string {
  return `${actionable.cause} ${actionable.nextAction}`;
}
