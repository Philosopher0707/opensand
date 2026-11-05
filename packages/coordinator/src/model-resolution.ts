/**
 * Agent records historically used the sentinel string "default" to mean
 * "use the active configured model". It is not a provider model identifier;
 * sending it to an LLM provider produces a 400 Bad Request. Resolve that
 * sentinel (and empty values) to the ambient default before any client is
 * constructed.
 */
export function resolveAgentModel(
  agentModel: string | null | undefined,
  defaultModel: string | null | undefined,
  fallbackModel = "qwen3:8b"
): string {
  const candidate = typeof agentModel === "string" ? agentModel.trim() : "";
  if (candidate && candidate !== "default") return candidate;

  const fallback = typeof defaultModel === "string" ? defaultModel.trim() : "";
  if (fallback && fallback !== "default") return fallback;

  return fallbackModel;
}
