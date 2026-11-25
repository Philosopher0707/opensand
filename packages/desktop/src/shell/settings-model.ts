// Pure state logic for the Preact Settings and Welcome views.
// Kept in src/ so the same rules are unit-testable and reusable by the HTTP layer.

import { isOllamaEndpoint, type OllamaStatus } from "../onboarding.js";
import type { ExternalEngineConfig } from "@opensand/coordinator";
import type { DesktopSettings } from "@opensand/shared";

export type ProviderId = "openai" | "anthropic" | "openrouter";

export type EngineId = "opensand" | "claude" | "opencode" | "codex" | "copilot" | "antigravity" | "workbuddy";

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

/** Plain validation message, or null when the form can be saved. External engines use their own account. */
export function validateSettingsForm(form: SettingsForm, hasSavedKey: boolean, engine: EngineId = "opensand"): string | null {
  if (isExternalEngine(engine)) return null;
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

export const ENGINE_OPTIONS: Array<{ id: EngineId; label: string; short: string }> = [
  { id: "opensand", label: "OpenSand (API key)", short: "OpenSand" },
  { id: "claude", label: "Claude Code (your account)", short: "Claude Code" },
  { id: "opencode", label: "OpenCode (your account)", short: "OpenCode" },
  { id: "codex", label: "Codex (your account)", short: "Codex" },
  { id: "copilot", label: "GitHub Copilot (your account)", short: "GitHub Copilot" },
  { id: "antigravity", label: "Antigravity (your account)", short: "Antigravity" },
  { id: "workbuddy", label: "WorkBuddy (your account)", short: "WorkBuddy" },
];

export function isExternalEngine(id: EngineId): boolean {
  return id !== "opensand";
}

export function enginePayload(engine: EngineId): { engine: EngineId } {
  return { engine };
}

/** Single production mapping from the saved per-engine choice to the config used by the next turn. */
export function selectedEngineConfig(engine?: EngineId, models?: Partial<Record<EngineId, string>>): ExternalEngineConfig | undefined {
  if (!engine || engine === "opensand") return undefined;
  return { type: "external", engine, model: models?.[engine] };
}

/** Save body: an external engine sends only `{ engine }` (no provider fields, no typed key). */
export function savePayload(form: SettingsForm, engine: EngineId, models?: DesktopSettings["engineModels"]): Partial<DesktopSettings> {
  const engineFields = { ...enginePayload(engine), ...(models && Object.keys(models).length ? { engineModels: models } : {}) };
  return isExternalEngine(engine) ? engineFields : { ...settingsPayload(form), ...engineFields };
}

/** Public shape of one engine status: explicit flags only, never paths, versions or CLI messages. */
export interface EngineStatus {
  engine: string;
  installed: boolean;
  signedIn: boolean;
  models: Array<{ id: string; label: string }>;
  modelsSource: "live" | "fallback" | "error";
  modelsMessage?: string;
}

/** Allowlist projection for the HTTP route: a new field on the detector never leaks by default. */
export function toEngineStatus(results: Array<{ engine: string; installed: boolean; authenticated?: boolean; models?: Array<{ id: string; label: string }>; modelsSource?: "live" | "fallback" | "error"; modelsMessage?: string }>): EngineStatus[] {
  return results.map((r) => ({
    engine: String(r.engine), installed: r.installed === true, signedIn: r.authenticated === true,
    models: Array.isArray(r.models) ? r.models : [], modelsSource: r.modelsSource ?? "error",
    ...(typeof r.modelsMessage === "string" ? { modelsMessage: r.modelsMessage } : {}),
  }));
}

/** Detection must never block Settings: a failure keeps OpenSand selectable and says so plainly. */
export const ENGINE_STATUS_UNAVAILABLE = "Engine status is unavailable right now. OpenSand stays selected; reopen Settings to try again.";

export async function loadEngineStatus(
  detect: (() => Promise<Array<{ engine: string; installed: boolean; models?: Array<{ id: string; label: string }>; modelsSource?: "live" | "fallback" | "error"; modelsMessage?: string }>>) | undefined
): Promise<{ detected: Array<{ engine: string; installed: boolean; models?: Array<{ id: string; label: string }>; modelsSource?: "live" | "fallback" | "error"; modelsMessage?: string }>; unavailable: boolean }> {
  if (!detect) return { detected: [], unavailable: false };
  try {
    return { detected: await detect(), unavailable: false };
  } catch {
    return { detected: [], unavailable: true };
  }
}

/** Disable unauthenticated/absent engine choices with a plain reason; never select one that is missing. */
export function resolveEngineChoice(
  saved: unknown,
  detected: Array<{ engine: string; installed: boolean }>
): { selected: EngineId; missing: EngineId[]; hint: string } {
  const external = ENGINE_OPTIONS.filter((o) => isExternalEngine(o.id));
  const missing = external.filter((o) => !detected.find((d) => d.engine === o.id)?.installed).map((o) => o.id);
  const requested = ENGINE_OPTIONS.find((o) => o.id === saved)?.id ?? "opensand";
  const selected = requested !== "opensand" && missing.includes(requested) ? "opensand" : requested;
  const hint = missing.length
    ? `${missing.map((id) => `${ENGINE_OPTIONS.find((o) => o.id === id)!.short} is not installed on this computer.`).join(" ")} Install what you want to use, then reopen Settings to select it.`
    : "";
  return { selected, missing, hint };
}
