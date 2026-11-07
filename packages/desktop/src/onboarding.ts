import type { DesktopSettings } from './types.js';

export const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
export const OLLAMA_CHAT_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';

export interface OllamaStatus {
  available: boolean;
  models: string[];
}

export interface OnboardingState {
  needsOnboarding: boolean;
  hasApiKey: boolean;
  endpoint: string;
  model: string;
  ollama: OllamaStatus;
}

interface SettingsSource {
  getSanitizedSettingsResolved(): Promise<DesktopSettings>;
}

export async function probeOllama(timeoutMs = 500): Promise<OllamaStatus> {
  try {
    const res = await fetch(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { available: false, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

export function hasConfiguredKey(settings: DesktopSettings): boolean {
  const key = settings.apiKey;
  return Boolean(key && key !== 'none');
}

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/** The shipped default points at Ollama; any other local endpoint was chosen on purpose. */
export function isOllamaEndpoint(endpoint: string): boolean {
  return isLocalEndpoint(endpoint) && endpoint.includes(':11434');
}

/**
 * Onboarding is needed only when there is no usable key and no local model
 * server to fall back on. Ollama running means a zero-config first run.
 */
export async function getOnboardingState(
  source: SettingsSource,
  probe: () => Promise<OllamaStatus> = probeOllama,
): Promise<OnboardingState> {
  const settings = await source.getSanitizedSettingsResolved();
  const hasApiKey = hasConfiguredKey(settings);
  const endpoint = settings.endpoint;
  const ollamaEndpoint = isOllamaEndpoint(endpoint);
  const ollama = ollamaEndpoint ? await probe() : { available: false, models: [] };
  // A local endpoint that is not Ollama (LM Studio, llama.cpp) was configured on
  // purpose, so treat it as a working setup rather than onboarding again.
  const deliberateLocal = isLocalEndpoint(endpoint) && !ollamaEndpoint;

  return {
    needsOnboarding: !hasApiKey && !ollama.available && !deliberateLocal,
    hasApiKey,
    endpoint,
    model: settings.model,
    ollama,
  };
}
