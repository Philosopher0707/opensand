// packages/desktop/renderer-next/src/views/Inspector.tsx
// Preact Detail Inspector slide-out panel (Phase 5 View Inventory Row 6).
// Displays active persona, context token telemetry gauge, cognitive memories,
// granted skills, and session control actions.

import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  DEFAULT_PERSONA,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  computeTelemetryPct,
  formatMemoryText,
  getTelemetryMeterColor,
  resolveAvatarIcon,
  resolvePersona,
  type AgentPersona,
  type CognitiveMemory,
  type GrantedSkill,
  type TokenTelemetry,
} from "../../../src/shell/inspector-model";

export interface InspectorProps {
  isOpen: boolean;
  onClose: () => void;
  data: ShellData;
  activeAgentId?: string | null;
  currentSessionId?: string | null;
  onClearSession?: () => void;
  onRewind?: () => void;
  onCompact?: () => void;
}

export function Inspector({
  isOpen,
  onClose,
  data,
  activeAgentId,
  currentSessionId,
  onClearSession,
  onRewind,
  onCompact,
}: InspectorProps) {
  const [persona, setPersona] = useState<AgentPersona>(DEFAULT_PERSONA);
  const [telemetry, setTelemetry] = useState<TokenTelemetry>(DEFAULT_TELEMETRY);
  const [memories, setMemories] = useState<CognitiveMemory[]>([]);
  const [skills, setSkills] = useState<GrantedSkill[]>(DEFAULT_SKILLS);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    // 1. Fetch persona / agents
    if (data.getAgents) {
      data
        .getAgents()
        .then((agents) => {
          if (cancelled) return;
          const resolved = resolvePersona(agents as AgentPersona[], activeAgentId);
          setPersona(resolved);
        })
        .catch(() => {
          if (!cancelled) setPersona(DEFAULT_PERSONA);
        });
    } else {
      setPersona(DEFAULT_PERSONA);
    }

    // 2. Fetch context token telemetry
    if (data.getTokenTelemetry) {
      data
        .getTokenTelemetry(activeAgentId || undefined, currentSessionId || undefined)
        .then((res) => {
          if (cancelled || !res) return;
          const used = res.estimatedTokens ?? 0;
          const max = res.maxContextTokens ?? 1048576;
          setTelemetry({
            estimatedTokens: used,
            maxContextTokens: max,
            pct: computeTelemetryPct(used, max),
          });
        })
        .catch(() => {
          if (!cancelled) setTelemetry(DEFAULT_TELEMETRY);
        });
    }

    // 3. Fetch cognitive memories
    if (data.listMemories) {
      data
        .listMemories({ agentId: activeAgentId || undefined, sessionId: currentSessionId || undefined })
        .then((res) => {
          if (cancelled) return;
          if (Array.isArray(res) && res.length > 0) {
            setMemories(res);
          } else {
            setMemories([]);
          }
        })
        .catch(() => {
          if (!cancelled) setMemories([]);
        });
    }

    // 4. Fetch granted skills
    if (data.listSkills) {
      data
        .listSkills()
        .then((res) => {
          if (cancelled) return;
          if (Array.isArray(res) && res.length > 0) {
            setSkills(res as GrantedSkill[]);
          } else {
            setSkills(DEFAULT_SKILLS);
          }
        })
        .catch(() => {
          if (!cancelled) setSkills(DEFAULT_SKILLS);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, activeAgentId, currentSessionId, data]);

  const pct = telemetry.pct ?? computeTelemetryPct(telemetry.estimatedTokens, telemetry.maxContextTokens);

  const handleRewind = () => {
    if (onRewind) {
      onRewind();
      return;
    }
    const rollbackBtn = document.getElementById("btnOpenRollback");
    if (rollbackBtn) {
      rollbackBtn.click();
    } else {
      window.dispatchEvent(new CustomEvent("opensand:open_rollback"));
    }
  };

  const handleCompact = () => {
    if (onCompact) {
      onCompact();
      return;
    }
    const compactBtn = document.getElementById("btnOpenCompact");
    if (compactBtn) {
      compactBtn.click();
    } else {
      window.dispatchEvent(new CustomEvent("opensand:open_compact"));
    }
  };

  const handleClear = async () => {
    if (onClearSession) {
      onClearSession();
      return;
    }
    if (data.clearAllSessions) {
      try {
        await data.clearAllSessions();
      } catch {}
    }
    const legacyClearBtn = document.getElementById("btnMenuClearSessions");
    if (legacyClearBtn) {
      legacyClearBtn.click();
    }
  };

  const handleExportBot = async () => {
    try {
      const idToExport = activeAgentId || "default-assistant";
      let templateData: any = null;
      if (data.exportAgentTemplate) {
        try {
          templateData = await data.exportAgentTemplate(idToExport);
        } catch {}
      }
      if (!templateData) {
        templateData = {
          templateVersion: "1.0",
          name: persona.name || "OpenSand Assistant",
          role: persona.role || "Universal Clean-Room Coding Agent",
          systemPrompt: persona.systemPrompt || DEFAULT_PERSONA.systemPrompt,
          model: persona.model || "stealth/crouton-alpha",
        };
      }
      const blob = new Blob([JSON.stringify(templateData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(templateData.name || "bot").toLowerCase().replace(/\s+/g, "-")}-template.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Error exporting bot template:", err);
    }
  };

  return (
    <aside
      class={`detail-panel ${isOpen ? "" : "hidden"}`}
      id="detailPanel"
      aria-label="Bot Profile and Session Details"
      aria-hidden={!isOpen}
    >
      <div class="detail-header">
        <div class="detail-header-title">
          <span class="detail-header-icon" aria-hidden="true">ℹ️</span>
          <span>Bot Profile & Details</span>
        </div>
        <button
          id="btnCloseDetail"
          type="button"
          class="btn-icon-ghost"
          aria-label="Close details"
          title="Close (Esc)"
          onClick={onClose}
        >
          &times;
        </button>
      </div>

      <div class="detail-body">
        {/* Active Persona Card */}
        <section class="detail-section">
          <div class="detail-section-title">Active Persona</div>
          <div class="detail-bot-card">
            <div class="detail-bot-header">
              <div class="detail-bot-avatar" id="detailBotAvatar">
                {resolveAvatarIcon(persona)}
              </div>
              <div class="detail-bot-identity">
                <div class="detail-bot-name" id="detailBotName">{persona.name}</div>
                <div class="detail-bot-role" id="detailBotRole">
                  {persona.role || "Autonomous Specialist"}
                </div>
              </div>
            </div>
            <div class="detail-bot-model-tag" id="detailBotModelTag">
              <span>Model:</span> <code id="detailBotModelCode">{persona.model || "stealth/crouton-alpha"}</code>
            </div>
            <div class="detail-prompt-label">System Instructions:</div>
            <div class="detail-prompt-preview" id="detailBotPromptPreview">
              {persona.systemPrompt || "Standard clean-room coding instructions."}
            </div>
          </div>
        </section>

        {/* Context Window Telemetry Gauge */}
        <section class="detail-section">
          <div class="detail-section-title">Context Window Utilization</div>
          <div class="detail-telemetry-box">
            <div class="detail-telemetry-row">
              <span class="detail-telemetry-label">Used Tokens</span>
              <span class="detail-telemetry-val" id="detailTokensUsed">
                {telemetry.estimatedTokens.toLocaleString()} tokens
              </span>
            </div>
            <div class="detail-meter-track">
              <div
                class="detail-meter-fill"
                id="detailMeterFill"
                style={{
                  width: `${Math.min(100, Math.max(0.75, pct))}%`,
                  background: getTelemetryMeterColor(pct),
                }}
              />
            </div>
            <div class="detail-telemetry-row detail-telemetry-sub">
              <span>Context Limit: <strong id="detailTokensMax">{telemetry.maxContextTokens ? telemetry.maxContextTokens.toLocaleString() : "-"}</strong></span>
              <span id="detailTokensPct">{pct.toFixed(1)}%</span>
            </div>
          </div>
        </section>

        {/* Cognitive Memories */}
        <section class="detail-section">
          <div class="detail-section-title">Cognitive Memories & Habits</div>
          <div class="detail-memories-list" id="detailMemoriesList">
            {memories.length > 0 ? (
              memories.slice(0, 5).map((m, idx) => (
                <div key={idx} class="detail-memory-item">
                  {formatMemoryText(m)}
                </div>
              ))
            ) : (
              <div class="detail-empty-text">No learned memories in this session yet.</div>
            )}
          </div>
        </section>

        {/* Granted Skills */}
        <section class="detail-section">
          <div class="detail-section-title">Granted Skills & Recipes</div>
          <div class="detail-skills-tags" id="detailSkillsTags">
            {skills.slice(0, 10).map((s) => (
              <span key={s.id} class="detail-skill-chip" title={s.description || ""}>
                {s.name || s.id}
              </span>
            ))}
          </div>
        </section>

        {/* Session Actions */}
        <section class="detail-section">
          <div class="detail-section-title">Session Controls</div>
          <div class="detail-actions-col">
            <button id="btnDetailRewind" type="button" class="btn btn-secondary btn-block" onClick={handleRewind}>
              ⏪ Rewind Last Turn
            </button>
            <button id="btnDetailCompact" type="button" class="btn btn-secondary btn-block" onClick={handleCompact}>
              🧹 Auto-Compact Context
            </button>
            <button id="btnDetailExportBot" type="button" class="btn btn-secondary btn-block" onClick={handleExportBot}>
              📤 Export Bot Template
            </button>
            <button id="btnDetailClear" type="button" class="btn btn-danger btn-block" onClick={handleClear}>
              🗑️ Clear Session
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}
