// Provider settings in the Preact shell. The stored key is never rendered or logged:
// it loads as a mask, the input starts empty, and a blank submit leaves it untouched.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import { viewPanelId, type ViewId } from "../../../src/shell/navigation-model";
import {
  connectionError,
  maskedKey,
  saveErrorMessage,
  settingsPayload,
  validateSettingsForm,
  type ProviderId,
  type SettingsForm,
} from "../../../src/shell/settings-model";

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
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
      .then((settings) => {
        if (!live) return;
        setProvider(settings.provider ?? "openai");
        setEndpoint(settings.endpoint ?? "");
        setModel(settings.model ?? "");
        setHasSavedKey(Boolean(maskedKey(settings.apiKey)));
        setApiKey(""); // never put the stored key into an input
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

  const form: SettingsForm = { provider, endpoint, model, apiKey };
  const disabled = loading || busy !== null;

  const save = async () => {
    setError(null);
    setSuccess(null);
    const problem = validateSettingsForm(form, hasSavedKey);
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
      await data.saveSettings(settingsPayload(form));
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
    const problem = validateSettingsForm(form, hasSavedKey);
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
      <div class="settings-field">
        <label for={id("Model")}>Model</label>
        <input
          id={id("Model")}
          type="text"
          value={model}
          disabled={disabled}
          autocomplete="off"
          onInput={(event) => setModel((event.currentTarget as HTMLInputElement).value)}
        />
      </div>
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
      <div class="settings-actions">
        <button id={id("Save")} type="submit" class="btn btn-primary" disabled={disabled}>
          {busy === "save" ? "Saving…" : "Save settings"}
        </button>
        <button id={id("Test")} type="button" class="btn btn-secondary" disabled={disabled} onClick={() => void test()}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
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
        {loading ? <p class="settings-loading" role="status">Loading settings…</p> : formNode}
      </div>
    </div>
  );
}
