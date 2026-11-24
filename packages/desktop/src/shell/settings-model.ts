// Pure state logic for the Preact Settings and Welcome views.
// Kept in src/ so the same rules are unit-testable and reusable by the HTTP layer.

import { isOllamaEndpoint, type OllamaStatus } from "../onboarding.js";

export type ProviderId = "openai" | "anthropic" | "openrouter";

/** The only representation of a saved key that may reach the renderer. */
export const MASKED_KEY = "********";

export interface SettingsForm {
  provider: ProviderId;
  endpoint: string;
  model: string;
  /** Freshly typed key, or MASKED_KEY when the saved key was left untouched. */
  apiKey: string;
}

/** A saved key becomes a mask; an absent key becomes an empty field. The raw key never comes back. */
export function maskedKey(apiKey: string | undefined): string {
  return apiKey && apiKey !== "none" ? MASKED_KEY : "";
}

/** A masked or empty key is omitted, so saving cannot overwrite the stored secret with asterisks. */
export function settingsPayload(form: SettingsForm): Record<string, string> {
  const payload: Record<string, string> = {
    provider: form.provider,
    endpoint: form.endpoint.trim(),
    model: form.model.trim(),
  };
  const key = form.apiKey.trim();
  if (key && key !== MASKED_KEY) payload.apiKey = key;
  return payload;
}

/** Plain validation message, or null when the form can be saved. */
export function validateSettingsForm(form: SettingsForm, hasSavedKey: boolean): string | null {
  const endpoint = form.endpoint.trim();
  if (!/^https?:\/\//i.test(endpoint)) return "Enter an http or https endpoint.";
  if (!form.model.trim()) return "Enter a model name.";
  const key = form.apiKey.trim();
  if (!isOllamaEndpoint(endpoint) && !hasSavedKey && (!key || key === MASKED_KEY)) {
    return "Enter an API key.";
  }
  return null;
}

/** Redacts provider failures: no raw stack, no CLI flags, no endpoint echoed back. */
export function connectionError(status?: number, raw?: string): string {
  if (status === 401 || status === 403) return "The provider rejected the API key. Check the key and try again.";
  if (status === 404) return "The endpoint or model could not be found. Check both and try again.";
  if (status !== undefined && status >= 500) return "The provider is having trouble right now. Try again in a moment.";
  const text = (raw || "").toLowerCase();
  if (/econnrefused|fetch failed|network|offline|not answering|timeout|timed out/.test(text)) {
    return "Could not reach the provider. Check the endpoint and your connection.";
  }
  if (/unauthor|forbidden|invalid.*key|api key/.test(text)) {
    return "The provider rejected the API key. Check the key and try again.";
  }
  return "Could not connect. Check the endpoint, model and API key, then try again.";
}

/** Save failures are local; keep them short and never surface the exception text. */
export function saveErrorMessage(raw: unknown): string {
  const text = String(raw).toLowerCase();
  if (/fetch failed|network|econnrefused/.test(text)) {
    return "Could not reach OpenSand. Check that it is running, then try again.";
  }
  return "Could not save these settings. Check the fields and try again.";
}

export interface WelcomeViewState {
  ollamaDetected: boolean;
  localEnabled: boolean;
  message: string;
}

/** Ollama with no models cannot answer a turn, so the local choice stays disabled. */
export function welcomeState(ollama: OllamaStatus): WelcomeViewState {
  if (!ollama.available) {
    return { ollamaDetected: false, localEnabled: false, message: "Ollama was not detected on this computer." };
  }
  if (ollama.models.length === 0) {
    return {
      ollamaDetected: true,
      localEnabled: false,
      message: "Ollama is running but has no models yet. Add one, or use an API key.",
    };
  }
  return {
    ollamaDetected: true,
    localEnabled: true,
    message: `Ollama is running with ${ollama.models[0]}. You can use it with no API key.`,
  };
}
