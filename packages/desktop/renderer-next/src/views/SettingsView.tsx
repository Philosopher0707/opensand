// Provider settings in the Preact shell. The stored key is never rendered or logged:
// it loads as a mask, the input starts empty, and a blank submit leaves it untouched.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import { viewPanelId, type ViewId } from "../../../src/shell/navigation-model";
import {
  connectionError,
  ENGINE_OPTIONS,
  ENGINE_STATUS_UNAVAILABLE,
  isExternalEngine,
  loadEngineStatus,
  maskedKey,
  providerFieldsVisible,
  resolveEngineChoice,
  saveErrorMessage,
  savePayload,
  settingsPayload,
  validateSettingsForm,
  type EngineId,
  type ProviderId,
  type SettingsForm,
} from "../../../src/shell/settings-model";
import { versionLabel } from "../../../src/shell/version-model.js";

export interface SettingsViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  /** Welcome embeds the same form inline and leaves via onSaved. */
  embedded?: boolean;
  onSaved?: () => void;
  onCancel?: () => void;
}

export function SettingsView({ data, active, onSelect, embedded, onSaved, onCancel }: SettingsViewProps) {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [engine, setEngine] = useState<EngineId>("opensand");
  const [engineMissing, setEngineMissing] = useState<EngineId[]>([]);
  const [engineHint, setEngineHint] = useState("");
  const [engineStatus, setEngineStatus] = useState<Array<{ engine: string; installed: boolean; models?: Array<{ id: string; label: string }>; modelsSource?: "live" | "fallback" | "error"; modelsMessage?: string }>>([]);
  const [engineModels, setEngineModels] = useState<Record<string, string>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [version, setVersion] = useState("…");

  // The inline copy shares a document with the always-mounted Settings panel: distinct ids
  // keep labels bound to the right control and let tests target one form unambiguously.
  const id = (suffix: string) => (embedded ? `welcomeSettings${suffix}` : `settings${suffix}`);

  useEffect(() => {
    if (!active && !embedded) return; // no request from the hidden registry panel
    let live = true;
    if (!data.getSettings) {
      setError("Settings are not available in this build.");
      setLoading(false);
      return;
    }
    setLoading(true);
    data.getSettings()
      .then(async (settings) => {
        if (!live) return;
        setProvider(settings.provider ?? "openai");
        setEndpoint(settings.endpoint ?? "");
        setModel(settings.model ?? "");
        setEngineModels({ ...((settings as any).engineModels ?? {}) });
        setHasSavedKey(Boolean(maskedKey(settings.apiKey)));
        setApiKey(""); // never put the stored key into an input
        setModelsLoading(true);
        const { detected, unavailable } = await loadEngineStatus(data.detectEngines?.bind(data));
        setModelsLoading(false);
        if (!live) return;
        const choice = resolveEngineChoice((settings as { engine?: unknown }).engine, detected);
        setEngine(choice.selected);
        setEngineStatus(detected);
        setEngineMissing(choice.missing);
        setEngineHint(unavailable ? ENGINE_STATUS_UNAVAILABLE : choice.hint);
      })
      .catch(() => {
        if (live) setError("Could not load settings. Check that OpenSand is running.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [data, active, embedded]);

  const selectedEngineStatus = engineStatus.find((item) => item.engine === engine);
  const selectedEngineModel = engine === "opensand" ? model : (engineModels[engine] ?? "");
  const offeredModels = selectedEngineStatus?.models ?? [];
  const savedModelStale = Boolean(selectedEngineModel && !offeredModels.some((item) => item.id === selectedEngineModel));

  useEffect(() => {
    if (!active || embedded) return; // no request from the hidden registry panel or the inline welcome form
    let live = true;
    if (!data.getVersion) {
      setVersion("Version unavailable");
      return;
    }
    data.getVersion()
      .then((report) => { if (live) setVersion(versionLabel(report)); })
      .catch(() => { if (live) setVersion("Version unavailable"); });
    return () => { live = false; };
  }, [data, active, embedded]);

  const form: SettingsForm = { provider, endpoint, model, apiKey };
  const disabled = loading || busy !== null;
  const accountEngine = isExternalEngine(engine);
  const showProviderFields = providerFieldsVisible(engine);

  const save = async () => {
    setError(null);
    setSuccess(null);
    const problem = validateSettingsForm(form, hasSavedKey, engine);
    if (problem) {
      setError(problem);
      return;
    }
    if (!data.saveSettings) {
      setError("Saving is not available in this build.");
      return;
    }
    setBusy("save");
    try {
      await data.saveSettings(savePayload(form, engine, engineModels));
      setSuccess("Saved. Your provider is ready to use.");
      setHasSavedKey(true);
      setApiKey(""); // a freshly saved key is never rendered back
      onSaved?.();
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setError(null);
    setSuccess(null);
    const problem = validateSettingsForm(form, hasSavedKey, engine);
    if (problem) {
      setError(problem);
      return;
    }
    if (!data.testConnection) {
      setError("Connection testing is not available in this build.");
      return;
    }
    setBusy("test");
    try {
      const result = await data.testConnection({ ...settingsPayload(form) });
      if (result.ok) setSuccess("Connection successful.");
      else setError(result.error || connectionError());
    } catch (err) {
      setError(connectionError(undefined, String(err)));
    } finally {
      setBusy(null);
    }
  };

  const formNode = (
    <form class="settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={busy !== null}>
      <div class="settings-field">
        <label for={id("Engine")}>Chat engine</label>
        <select
          id={id("Engine")}
          value={engine}
          disabled={disabled}
          aria-describedby={engineHint ? id("EngineHint") : undefined}
          onChange={(event) => setEngine((event.currentTarget as HTMLSelectElement).value as EngineId)}
        >
          {ENGINE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id} disabled={isExternalEngine(option.id) && engineMissing.includes(option.id)}>
              {option.label}
            </option>
          ))}
        </select>
        {engineHint && <p id={id("EngineHint")} class="settings-hint">{engineHint}</p>}
      </div>
      {showProviderFields && (
        <>
          <div class="settings-field">
            <label for={id("Provider")}>Provider</label>
            <select
              id={id("Provider")}
              value={provider}
              disabled={disabled}
              onChange={(event) => setProvider((event.currentTarget as HTMLSelectElement).value as ProviderId)}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </div>
          <div class="settings-field">
            <label for={id("Endpoint")}>Endpoint</label>
            <input
              id={id("Endpoint")}
              type="url"
              value={endpoint}
              disabled={disabled}
              autocomplete="off"
              onInput={(event) => setEndpoint((event.currentTarget as HTMLInputElement).value)}
            />
          </div>
        </>
      )}
      <div class="settings-field">
        <label for={id("Model")}>{isExternalEngine(engine) ? "Engine model" : "Model"}</label>
        <>
            <select
              id={id("Model")}
              value={selectedEngineModel}
              disabled={disabled || modelsLoading || offeredModels.length === 0}
              onChange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                if (engine === "opensand") setModel(value);
                else setEngineModels((current) => ({ ...current, [engine]: value }));
              }}
            >
              {selectedEngineModel && savedModelStale && <option value={selectedEngineModel}>{selectedEngineModel} (no longer offered)</option>}
              {!selectedEngineModel && <option value="">Choose a model</option>}
              {offeredModels.map((item) => <option key={item.id} value={item.id}>{item.label === item.id ? item.label : `${item.label} (${item.id})`}</option>)}
            </select>
            {modelsLoading && <p class="settings-hint" role="status">Loading models…</p>}
            {savedModelStale && <p class="settings-hint" role="status">This saved model is no longer offered. It will be kept unless you choose another.</p>}
            {!modelsLoading && offeredModels.length === 0 && <p class="settings-hint">No models are available for this engine. Check its installation or account, then reopen Settings.</p>}
            {selectedEngineStatus?.modelsMessage && <p class="settings-hint" role="status">{selectedEngineStatus.modelsMessage}</p>}
        </>
      </div>
      {showProviderFields && (
        <div class="settings-field">
          <label for={id("ApiKey")}>API key</label>
          <input
            id={id("ApiKey")}
            type="password"
            value={apiKey}
            disabled={disabled}
            autocomplete="new-password"
            placeholder={hasSavedKey ? "A key is saved — leave blank to keep it" : "Paste your API key"}
            onInput={(event) => setApiKey((event.currentTarget as HTMLInputElement).value)}
          />
          <p class="settings-hint">Keys are stored encrypted. A saved key is never shown again.</p>
        </div>
      )}
      <div class="settings-actions">
        <button id={id("Save")} type="submit" class="btn btn-primary" disabled={disabled}>
          {busy === "save" ? "Saving…" : "Save settings"}
        </button>
        {showProviderFields && (
          <button id={id("Test")} type="button" class="btn btn-secondary" disabled={disabled} onClick={() => void test()}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
        )}
        {onCancel && (
          <button id={id("Cancel")} type="button" class="btn btn-ghost" disabled={busy !== null} onClick={onCancel}>
            Back
          </button>
        )}
      </div>
      {error && <p id={id("Error")} class="settings-error" role="alert">{error}</p>}
      {success && <p id={id("Success")} class="settings-success" role="status" aria-live="polite">{success}</p>}
    </form>
  );

  if (embedded) return formNode;

  return (
    <div id={viewPanelId("settings")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container settings-view-container">
        <div class="dashboard-header">
          <div class="dashboard-title">Provider Settings</div>
          <div class="dashboard-subtitle">Connect a model provider. You can change it at any time.</div>
        </div>
        {loading ? <p class="settings-loading" role="status">Loading settings…{modelsLoading ? " Loading models…" : ""}</p> : formNode}
        <p id="settingsVersion" class="settings-version" aria-live="polite">{version}</p>
      </div>
    </div>
  );
}
