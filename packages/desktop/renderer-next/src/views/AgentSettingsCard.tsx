// Agent settings detail card: per-agent model parameters, enable state, logo
// SVG/color, and OpenRouter API key vault reference. Changes are PATCHed to
// /api/agents/:id/settings and the raw key never travels on the wire — only a
// keyId reference is stored alongside the agent record.
import { useState, useEffect } from "preact/hooks";
import type { AgentRecord, UpdateAgentSettingsInput } from "@opensand/shared";
import type { ShellData } from "../data";
import { Avatar } from "./Avatar";

export interface AgentSettingsCardProps {
  data: ShellData;
  agent: AgentRecord | null;
  onSaved?: (updated: AgentRecord) => void;
}

const FIELD_DEFAULTS: Record<string, any> = {
  enabled: false,
  temperature: 0.7,
  maxTokens: null,
  topP: null,
  logoSvg: null,
  logoColor: null,
  predictedOutcome: "pending",
  observedOutcome: "pending",
};

export function AgentSettingsCard({ data, agent, onSaved }: AgentSettingsCardProps) {
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) {
      setValues({});
      return;
    }
    setValues({
      enabled: agent.enabled ?? FIELD_DEFAULTS.enabled,
      temperature: agent.temperature ?? FIELD_DEFAULTS.temperature,
      maxTokens: agent.maxTokens ?? FIELD_DEFAULTS.maxTokens,
      topP: agent.topP ?? FIELD_DEFAULTS.topP,
      logoSvg: agent.logoSvg ?? FIELD_DEFAULTS.logoSvg,
      logoColor: agent.logoColor ?? FIELD_DEFAULTS.logoColor,
      predictedOutcome: agent.predictedOutcome ?? FIELD_DEFAULTS.predictedOutcome,
      observedOutcome: agent.observedOutcome ?? FIELD_DEFAULTS.observedOutcome,
    });
    setSaved(false);
    setError(null);
  }, [agent]);

  const handleChange = (key: string, value: any) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async (e: Event) => {
    e.preventDefault();
    if (!agent) return;
    setSaving(true);
    setError(null);

    const updates: UpdateAgentSettingsInput = {};
    if (values.enabled !== undefined) updates.enabled = !!values.enabled;
    if (values.temperature !== undefined) updates.temperature = Number(values.temperature);
    if (values.maxTokens !== undefined) updates.maxTokens = values.maxTokens ? Number(values.maxTokens) : undefined;
    if (values.topP !== undefined) updates.topP = values.topP ? Number(values.topP) : undefined;
    if (values.logoSvg !== undefined) updates.logoSvg = values.logoSvg || undefined;
    if (values.logoColor !== undefined) updates.logoColor = values.logoColor || undefined;
    if (values.predictedOutcome !== undefined) updates.predictedOutcome = values.predictedOutcome;
    if (values.observedOutcome !== undefined) updates.observedOutcome = values.observedOutcome;

    try {
      const updated = await data.updateAgentSettings(agent.id, updates);
      setSaved(true);
      setSaving(false);
      onSaved?.(updated as AgentRecord);
    } catch (err: any) {
      setError(err?.message || "Failed to save settings");
      setSaving(false);
    }
  };

  if (!agent) return null;

  return (
    <section class="agent-settings-card">
      <header class="card-header">
        <div class="card-header-avatar">
          <Avatar agent={agent} size={48} />
        </div>
        <div class="card-header-info">
          <h2 class="card-title">Settings — {agent.name}</h2>
          <p class="card-subtitle">{agent.role}</p>
          <span class={`agent-id-badge`} title={agent.id}>{agent.id}</span>
        </div>
      </header>

      {error ? <div class="card-error" role="alert">{error}</div> : null}
      {saved ? <div class="card-saved">Saved.</div> : null}

      <form class="card-form" onSubmit={handleSave}>
        <fieldset class="card-fieldset">
          <legend class="card-legend">Behavior</legend>

          <div class="card-field">
            <label class="card-label">
              <input
                type="checkbox"
                checked={!!values.enabled}
                onChange={(e) => handleChange("enabled", (e.target as HTMLInputElement).checked)}
              />
              Enabled — allow this agent to run turns
            </label>
            <span class="card-field-note">Disabled agents cannot execute turns until enabled.</span>
          </div>

          <div class="card-field">
            <label class="card-label">Model</label>
            <input
              type="text"
              class="card-input"
              value={agent.model ?? ""}
              onChange={(e) => handleChange("model", (e.target as HTMLInputElement).value)}
              disabled
            />
            <span class="card-field-note">Model is fixed at agent creation; change it via a new agent.</span>
          </div>

          <div class="card-field">
            <label class="card-label">Temperature</label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              class="card-slider"
              value={values.temperature ?? FIELD_DEFAULTS.temperature}
              onChange={(e) => handleChange("temperature", (e.target as HTMLInputElement).valueAsNumber)}
            />
            <span class="card-field-value">{Number(values.temperature ?? FIELD_DEFAULTS.temperature).toFixed(1)}</span>
            <span class="card-field-note">Sampling randomness (0 = deterministic, 2 = creative).</span>
          </div>

          <div class="card-field">
            <label class="card-label">Max output tokens</label>
            <input
              type="number"
              min="1"
              class="card-input"
              value={values.maxTokens ?? ""}
              onChange={(e) => handleChange("maxTokens", (e.target as HTMLInputElement).value)}
            />
            <span class="card-field-note">Maximum tokens per turn. Empty = model default.</span>
          </div>

          <div class="card-field">
            <label class="card-label">Top P</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="card-slider"
              value={values.topP ?? FIELD_DEFAULTS.topP}
              onChange={(e) => handleChange("topP", (e.target as HTMLInputElement).valueAsNumber)}
            />
            <span class="card-field-value">{Number(values.topP ?? FIELD_DEFAULTS.topP).toFixed(2)}</span>
            <span class="card-field-note">Nucleus sampling probability.</span>
          </div>
        </fieldset>

        <fieldset class="card-fieldset">
          <legend class="card-legend">Appearance</legend>

          <div class="card-field">
            <label class="card-label">Logo color</label>
            <input
              type="color"
              class="card-input color-picker"
              value={values.logoColor ?? "#6366f1"}
              onChange={(e) => handleChange("logoColor", (e.target as HTMLInputElement).value)}
            />
            <span class="card-field-note">Hex accent tinting the logo paths.</span>
          </div>

          <div class="card-field">
            <label class="card-label">Logo SVG</label>
            <textarea
              class="card-textarea"
              placeholder="Paste inline SVG markup for the agent avatar…"
              value={values.logoSvg ?? ""}
              onChange={(e) => handleChange("logoSvg", (e.target as HTMLTextAreaElement).value)}
            />
            <span class="card-field-note">Inline SVG rendered in the sidebar avatar slot.</span>
          </div>
        </fieldset>

        <fieldset class="card-fieldset">
          <legend class="card-legend">Outcomes</legend>

          <div class="card-field">
            <label class="card-label">Predicted outcome</label>
            <select
              class="card-select"
              value={values.predictedOutcome ?? "pending"}
              onChange={(e) => handleChange("predictedOutcome", (e.target as HTMLSelectElement).value)}
            >
              <option value="pending">Pending</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
              <option value="uncertain">Uncertain</option>
            </select>
            <span class="card-field-note">Outcome you expect this agent's sessions to produce.</span>
          </div>

          <div class="card-field">
            <label class="card-label">Observed outcome</label>
            <select
              class="card-select"
              value={values.observedOutcome ?? "pending"}
              onChange={(e) => handleChange("observedOutcome", (e.target as HTMLSelectElement).value)}
            >
              <option value="pending">Pending</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
              <option value="uncertain">Uncertain</option>
            </select>
            <span class="card-field-note">Outcome observed after the agent's turns complete.</span>
          </div>
        </fieldset>

        <fieldset class="card-fieldset">
          <legend class="card-legend">API Key (vault)</legend>

          <div class="card-field">
            <label class="card-label">OpenRouter API key</label>
            <input
              type="password"
              class="card-input secret-input"
              placeholder="•••••••• (stored in OS vault, never on wire)"
              readOnly
            />
            <span class="card-field-note">Raw key never travels on the wire. Only a keyId reference is stored alongside this agent.</span>
          </div>
        </fieldset>

        <div class="card-actions">
          <button type="button" class="btn btn-secondary" disabled={saving || saved}>
            {saved ? "Saved" : "Save changes"}
          </button>
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}
