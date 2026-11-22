// packages/desktop/src/shell/inspector-model.ts
// Pure model and state logic for the Preact Detail Inspector panel.

export interface AgentPersona {
  id: string;
  name: string;
  role?: string;
  model?: string;
  systemPrompt?: string;
  kind?: string;
  avatar?: string;
}

export interface TokenTelemetry {
  estimatedTokens: number;
  maxContextTokens: number;
  pct?: number;
}

export interface CognitiveMemory {
  id?: string;
  content?: string;
  fact?: string;
  rule?: string;
  [key: string]: unknown;
}

export interface GrantedSkill {
  id: string;
  name?: string;
  description?: string;
}

export const DEFAULT_PERSONA: AgentPersona = {
  id: "default-assistant",
  name: "OpenSand Assistant",
  role: "Universal Clean-Room Coding Agent",
  model: "stealth/crouton-alpha",
  systemPrompt:
    "Default Assistant System Prompt:\nYou are OpenSand, a local-first, universal clean-room coding agent.\nAdhere strictly to AGENTS.md rules: ground before action, surgical edits, zero unverified assumptions, honest verification.",
};

export const DEFAULT_TELEMETRY: TokenTelemetry = {
  estimatedTokens: 0,
  maxContextTokens: 1048576,
  pct: 0,
};

export const DEFAULT_SKILLS: GrantedSkill[] = [
  { id: "code-review", name: "code-review", description: "Clean-room code review" },
  { id: "architecture", name: "architecture", description: "Architecture and invariants" },
  { id: "debugging", name: "debugging", description: "Root cause analysis" },
];

export function computeTelemetryPct(used: number, max: number): number {
  if (!max || max <= 0) return 0;
  if (!used || used <= 0) return 0;
  return Math.min(100, Math.round((used / max) * 1000) / 10);
}

export function getTelemetryMeterColor(pct: number): string {
  if (pct > 80) return "var(--danger, #dc2626)";
  if (pct > 50) return "var(--warning, #d97706)";
  return "var(--accent-gradient, linear-gradient(135deg, #3b82f6, #8b5cf6))";
}

export function formatMemoryText(m: CognitiveMemory | string): string {
  if (typeof m === "string") return m;
  if (!m) return "";
  return m.content || m.fact || m.rule || (typeof m === "object" ? JSON.stringify(m) : String(m));
}

export function resolvePersona(
  agents: AgentPersona[] | null | undefined,
  activeAgentId?: string | null
): AgentPersona {
  if (Array.isArray(agents) && activeAgentId) {
    const found = agents.find((a) => a.id === activeAgentId);
    if (found) return found;
  }
  return DEFAULT_PERSONA;
}

export function resolveAvatarIcon(persona: AgentPersona): string {
  if (persona.kind === "ROOM") return "👥";
  if (persona.kind === "SPECIALIST") return "✨";
  return "🤖";
}
