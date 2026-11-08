import type { SessionSummary, SessionMetadata } from "@opensand/coordinator";
import type { CliConfig } from "./config.js";

export interface SessionMatch {
  session?: SessionSummary;
  /** More than one session matches the typed prefix. */
  ambiguous?: SessionSummary[];
}

/** Resolve a `--resume` / `/resume` argument: "latest", an id, or a unique prefix. */
export function matchSession(sessions: SessionSummary[], query: string): SessionMatch {
  if (query === "latest") {
    return { session: sessions[0] };
  }
  const exact = sessions.find((s) => s.sessionId === query);
  if (exact) return { session: exact };
  const matches = sessions.filter((s) => s.sessionId.startsWith(query));
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return {};
}

export interface ResumeValidationResult {
  valid: boolean;
  endpoint: string;
  model: string;
  apiKey?: string;
  provider?: string;
  warning?: string;
  error?: string;
}

/**
 * Validate credential availability and model endpoint resolution before resuming a session.
 * Precedence: CLI flags > persisted session configuration > defaults.
 * In batch mode (--query), returns an actionable error message if API key is missing.
 */
export function validateResumeEnvironment(
  sessionMeta: SessionMetadata | undefined,
  cliConfig: Partial<CliConfig> & {
    explicitFlags?: Set<string>;
    explicitEndpoint?: boolean;
    explicitModel?: boolean;
    explicitApiKey?: boolean;
  }
): ResumeValidationResult {
  const defaultEndpoint = "https://api.openai.com/v1";
  const defaultModel = "gpt-4o";

  // 1. Model resolution: CLI flag > sessionMeta > defaults
  const hasCliModel = Boolean(
    cliConfig.explicitModel ||
      cliConfig.explicitFlags?.has("model") ||
      (cliConfig.model !== undefined &&
        cliConfig.model !== "" &&
        cliConfig.model !== defaultModel &&
        (!sessionMeta || cliConfig.model !== sessionMeta.model)) ||
      (cliConfig.model !== undefined && !sessionMeta?.model)
  );

  const resolvedModel = hasCliModel
    ? cliConfig.model!
    : sessionMeta?.model ||
      cliConfig.model ||
      process.env.OPENSAND_MODEL ||
      defaultModel;

  // 2. Endpoint resolution: CLI flag > sessionMeta > defaults
  const hasCliEndpoint = Boolean(
    cliConfig.explicitEndpoint ||
      cliConfig.explicitFlags?.has("endpoint") ||
      (cliConfig.endpoint !== undefined &&
        cliConfig.endpoint !== "" &&
        cliConfig.endpoint !== defaultEndpoint &&
        (!sessionMeta || cliConfig.endpoint !== sessionMeta.endpoint)) ||
      (cliConfig.endpoint !== undefined && !sessionMeta?.endpoint)
  );

  const resolvedEndpoint = hasCliEndpoint
    ? cliConfig.endpoint!
    : sessionMeta?.endpoint ||
      cliConfig.endpoint ||
      process.env.OPENSAND_ENDPOINT ||
      process.env.OPENAI_BASE_URL ||
      defaultEndpoint;

  // 3. Provider resolution
  const resolvedProvider = cliConfig.provider || sessionMeta?.provider;

  // 4. Credential resolution
  const hasCliApiKey = Boolean(
    cliConfig.explicitApiKey ||
      cliConfig.explicitFlags?.has("apiKey") ||
      (cliConfig.apiKey !== undefined && cliConfig.apiKey.trim() !== "")
  );

  const resolvedApiKey = hasCliApiKey
    ? cliConfig.apiKey
    : process.env.OPENSAND_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      cliConfig.apiKey;

  // 5. Credential validation against resolved endpoint
  const isCloud =
    resolvedEndpoint.includes("api.openai.com") ||
    resolvedEndpoint.includes("api.anthropic.com") ||
    (!resolvedEndpoint.includes("127.0.0.1") &&
      !resolvedEndpoint.includes("localhost") &&
      !resolvedEndpoint.includes("192.168.") &&
      !resolvedEndpoint.includes("10."));

  const hasValidApiKey = Boolean(
    resolvedApiKey && resolvedApiKey.trim() !== "" && resolvedApiKey !== "none"
  );

  if (isCloud && !hasValidApiKey) {
    const errorDetails =
      `No API key configured for cloud endpoint ${resolvedEndpoint}.\n` +
      `  Fix options:\n` +
      `  1. Set environment variable: export OPENAI_API_KEY="sk-..."\n` +
      `  2. Pass key on launch: opensand --api-key "sk-..."\n` +
      `  3. Use local Ollama: opensand --endpoint http://127.0.0.1:11434/v1 --model qwen3:8b`;

    return {
      valid: false,
      endpoint: resolvedEndpoint,
      model: resolvedModel,
      provider: resolvedProvider,
      apiKey: undefined,
      error: cliConfig.query ? errorDetails : undefined,
      warning: !cliConfig.query ? errorDetails : undefined,
    };
  }

  return {
    valid: true,
    endpoint: resolvedEndpoint,
    model: resolvedModel,
    provider: resolvedProvider,
    apiKey: resolvedApiKey,
  };
}
