// First-run setup at /welcome. Shows the local-model probe result and offers a
// one-click local setup or the same Settings form inline for an API key.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import type { OllamaStatus } from "../../../src/onboarding";
import { viewPanelId, type ViewId } from "../../../src/shell/navigation-model";
import { saveErrorMessage, welcomeState } from "../../../src/shell/settings-model";
import { SettingsView } from "./SettingsView";

export interface WelcomeViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
}

export function WelcomeView({ data, active, onSelect }: WelcomeViewProps) {
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingLocal, setSavingLocal] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);

  useEffect(() => {
    if (!active) return; // a hidden welcome panel must not probe the network
    let live = true;
    setLoading(true);
    if (!data.getOnboardingState) {
      setError("Setup is not available in this build.");
      setLoading(false);
      return;
    }
    data.getOnboardingState()
      .then((state) => {
        if (live) setOllama(state.ollama);
      })
      .catch(() => {
        if (live) setError("Could not check this computer. Check that OpenSand is running.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [data, active]);

  const useLocal = async () => {
    if (!ollama || ollama.models.length === 0) return;
    setError(null);
    setSavingLocal(true);
    try {
      if (!data.saveOnboarding) throw new Error("Setup is unavailable in this build");
      await data.saveOnboarding({ mode: "ollama", model: ollama.models[0] });
      onSelect("chat");
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setSavingLocal(false);
    }
  };

  const state = ollama ? welcomeState(ollama) : null;

  return (
    <div id={viewPanelId("welcome")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container welcome-view-container">
        <div class="dashboard-header">
          <div class="dashboard-title">Welcome to OpenSand</div>
          <div class="dashboard-subtitle">Choose how OpenSand should answer. You can change this later in Settings.</div>
        </div>
        {loading && <p id="welcomeLoading" class="welcome-loading" role="status">Checking this computer for a local model…</p>}
        {error && <p id="welcomeError" class="settings-error" role="alert">{error}</p>}
        {state && <p id="welcomeOllamaStatus" class="welcome-status">{state.message}</p>}
        {state && !showKeyForm && (
          <div class="welcome-choices">
            <section class="welcome-choice">
              <h3>Use local Ollama</h3>
              <p>No API key needed. OpenSand uses a model already on this computer.</p>
              <button
                id="btnUseOllama"
                type="button"
                class="btn btn-primary"
                disabled={!state.localEnabled || savingLocal}
                onClick={() => void useLocal()}
              >
                {savingLocal ? "Starting…" : "Use local Ollama"}
              </button>
            </section>
            <section class="welcome-choice">
              <h3>Add an API key</h3>
              <p>Connect a hosted provider such as OpenAI or OpenRouter.</p>
              <button
                id="btnWelcomeAddKey"
                type="button"
                class="btn btn-secondary"
                onClick={() => { setShowKeyForm(true); setError(null); }}
              >
                Add an API key
              </button>
            </section>
          </div>
        )}
        {showKeyForm && (
          <div class="welcome-inline-settings">
            <h3>Add an API key</h3>
            <SettingsView
              data={data}
              active={active}
              onSelect={onSelect}
              embedded
              onSaved={() => onSelect("chat")}
              onCancel={() => { setShowKeyForm(false); setError(null); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
