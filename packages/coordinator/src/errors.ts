/**
 * Error Taxonomy for OpenSand
 * Maps provider, daemon, gate, and OS errors to user-actionable causes and next steps.
 * Prevents raw stack traces in the UI.
 */

export interface ActionableError {
  code: string;
  cause: string;
  nextAction: string;
  isUserFixable: boolean;
  statusCode?: number;
  rawMessage?: string;
}

export function classifyError(err: unknown): ActionableError {
  const msg = err instanceof Error ? err.message : String(err || '');
  const lower = msg.toLowerCase();
  const status = (err as any)?.status || (err as any)?.statusCode;

  // 1. Authentication & API keys (401 / 403)
  if (status === 401 || lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('invalid_api_key')) {
    return {
      code: 'AUTH_INVALID_KEY',
      cause: 'The model provider rejected your API key.',
      nextAction: 'Check or re-enter your API key in Settings.',
      isUserFixable: true,
      statusCode: 401,
      rawMessage: msg,
    };
  }

  // 2. Rate Limits & Quotas (429)
  if (status === 429 || lower.includes('429') || lower.includes('rate limit') || lower.includes('quota exceeded')) {
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      cause: 'You exceeded the model provider rate limit or token quota.',
      nextAction: 'Wait a few moments before trying again, or switch to a local model.',
      isUserFixable: true,
      statusCode: 429,
      rawMessage: msg,
    };
  }

  // 3. Provider Downtime & Server Errors (500, 502, 503, 504)
  if (status === 503 || status === 502 || status === 504 || status === 500 || lower.includes('overloaded') || lower.includes('service unavailable')) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      cause: 'The model provider is temporarily overloaded or down for maintenance.',
      nextAction: 'Try again in a few minutes, or switch to another model provider in Settings.',
      isUserFixable: false,
      statusCode: status || 503,
      rawMessage: msg,
    };
  }

  // 4. Local Ollama unreachable
  if (lower.includes('econnrefused 127.0.0.1:11434') || lower.includes('ollama') && lower.includes('connect')) {
    return {
      code: 'OLLAMA_UNREACHABLE',
      cause: 'Local Ollama service is not running or not listening on port 11434.',
      nextAction: 'Start Ollama from your Applications menu or run `ollama serve` in a terminal.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 5. Network connectivity
  if (lower.includes('enotfound') || lower.includes('getaddrinfo') || lower.includes('network offline') || lower.includes('econnreset')) {
    return {
      code: 'NETWORK_OFFLINE',
      cause: 'Could not connect to the remote server.',
      nextAction: 'Check your internet connection and proxy settings.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 6. Action / Tool denied by user
  if (lower.includes('permission_denied') || lower.includes('approval rejected') || lower.includes('denied by user') || lower.includes('tool rejected')) {
    return {
      code: 'TOOL_APPROVAL_DENIED',
      cause: 'The tool execution was denied by policy or user approval.',
      nextAction: 'Rephrase your request or click Approve on the permission card if you want to allow it.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 7. Command timeout
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return {
      code: 'EXECUTION_TIMEOUT',
      cause: 'The operation or command exceeded the allowed execution time.',
      nextAction: 'Break the task into smaller steps or run the command directly in terminal.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 8. File Not Found (ENOENT)
  if (lower.includes('enoent') || lower.includes('no such file or directory')) {
    return {
      code: 'FILE_NOT_FOUND',
      cause: 'The requested file or directory does not exist.',
      nextAction: 'Verify the file path exists in your workspace.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 9. OS Permission Denied (EACCES / EPERM)
  if (lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied')) {
    return {
      code: 'FS_PERMISSION_DENIED',
      cause: 'Operating system denied permission to read or write the file.',
      nextAction: 'Check filesystem permissions for the target folder.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 10. Disk Full (ENOSPC)
  if (lower.includes('enospc') || lower.includes('no space left on device')) {
    return {
      code: 'DISK_FULL',
      cause: 'Your disk has run out of free space.',
      nextAction: 'Free up disk space on your drive and retry.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 11. Context window exceeded
  if (lower.includes('context length') || lower.includes('maximum context') || lower.includes('prompt too long')) {
    return {
      code: 'CONTEXT_LENGTH_EXCEEDED',
      cause: 'The conversation context exceeds the model maximum token limit.',
      nextAction: 'Start a new session or compact history using the Compact button.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // 12. State migration downgrade
  if (lower.includes('downgrade') || lower.includes('newer version of opensand')) {
    return {
      code: 'STATE_DOWNGRADE_REFUSED',
      cause: 'Your state files were created by a newer version of OpenSand.',
      nextAction: 'Update OpenSand to the latest version to access this state.',
      isUserFixable: true,
      rawMessage: msg,
    };
  }

  // Default fallback
  return {
    code: 'UNKNOWN_ERROR',
    cause: msg || 'An unexpected error occurred during execution.',
    nextAction: 'Try re-running your request or check logs for diagnostics.',
    isUserFixable: false,
    rawMessage: msg,
  };
}
