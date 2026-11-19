/**
 * @opensand/shared — canonical types & contracts shared by
 * coordinator, local-exec-daemon, desktop, cli, and native-bridge.
 *
 * Single authority per decision (engineering rule #3): every package
 * imports these definitions instead of re-declaring them.
 */

/* ── Tool definitions & execution ──────────────────────────────── */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, {
        type: string;
        description?: string;
        default?: any;
        items?: any;
        enum?: string[];
      }>;
      required?: string[];
    };
  };
}

/**
 * Why a tool call did not run. `error.code` names the failure; `reason` names
 * who or what stopped it, so the model can tell "ask the user" from "change
 * the path" from "do not retry".
 */
export type DenialReason =
  | "user_rejected" // the user declined the approval prompt
  | "approval_required" // needs approval and none was given yet
  | "policy" // a policy rule denied it
  | "hook" // a PreToolUse hook denied it
  | "not_authorized" // the tool is not in this agent's allowed tools
  | "workspace_escape" // a path resolved outside the workspace
  | "safety_gate"; // the command safety gate blocked it

export interface ToolExecutionResult<T = any> {
  status: "ok" | "error" | "permission_pending";
  output?: T;
  error?: {
    code: string;
    message: string;
    reason?: DenialReason;
  };
  approvalId?: string;
}

/* ── Chat / LLM messages ───────────────────────────────────────── */

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface StreamDelta {
  content?: string;
  thinking?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  finish_reason?: string | null;
}

/* ── Agents ──────────────────────────────────────────────────── */

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
  /** Whether this agent may run turns. New agents start disabled until enabled. */
  enabled?: boolean;
  /** Inline SVG avatar for the sidebar/details logo; absent = default avatar. */
  logoSvg?: string;
  /** Hex accent color tinting the logo paths. */
  logoColor?: string;
  /** Sampling temperature (0-2). Absent = model default. */
  temperature?: number;
  /** Maximum output tokens per turn. Absent = model default. */
  maxTokens?: number;
  /** Nucleus sampling probability (0-1). Absent = model default. */
  topP?: number;
  /** Vault reference id for the provider API key; raw key never travels on wire. */
  openRouterApiKeyId?: string;
  /** Epoch ms when the key was last validated. */
  lastValidatedAt?: number;
  /** Last validation error message, if any. */
  validationError?: string | null;
  /** Predicted session outcome (set by user). */
  predictedOutcome?: "positive" | "negative" | "uncertain" | "pending";
  /** Observed session outcome (set after turn completes). */
  observedOutcome?: "positive" | "negative" | "uncertain" | "pending";
  /** Standing instructions — the persona body (the "soul"). */
  soul?: string;
  /** sha256 of soul, for spotting a SOUL.md edited outside the app. */
  soulHash?: string;
  /** Stored avatar image URL (file:// or served); null when none. */
  avatarUrl?: string | null;
  /** Approval mode for tool calls: "ask" (prompt each time), "custom" (alwaysAllow list), "allow" (auto-approve). */
  approvalMode?: "ask" | "custom" | "allow";
  /** Auto-approve tool calls without prompting. */
  autoApprove?: boolean;
  /** Tools this agent may always use without asking (when approvalMode === "custom"). */
  alwaysAllow?: string[];
  /** Optional labeled divider used to organize this agent in the sidebar. */
  section?: string;
  /** The coordinator for this agent's sidebar section. */
  chiefOfStaff?: boolean;
  /** Owner-selected additional sections this Chief may coordinate. */
  managedSections?: string[];
  /** Team member email who created this agent (Team Cloud only). */
  createdBy?: string;
  /** Member email this agent reports to (Team Cloud only). */
  reportsTo?: string;
  /** Who may see this agent: "everyone" | "admins" | { people: string[] }. */
  visibility?: "everyone" | "admins" | { people: string[] };
  /** This agent's own voice id. */
  voice?: string;
  /** Speak this agent's replies aloud as they settle. */
  speakReplies?: boolean;
  /** Whether this agent may send voice notes. */
  voiceNotes?: boolean;
  /** How replies are shaped. Absent = "default". */
  replyStyle?: "default" | "concise" | "detailed";
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  logoSvg?: string;
  logoColor?: string;
  soul?: string;
  avatarUrl?: string | null;
  approvalMode?: "ask" | "custom" | "allow";
  autoApprove?: boolean;
  alwaysAllow?: string[];
  section?: string;
  chiefOfStaff?: boolean;
  managedSections?: string[];
  createdBy?: string;
  reportsTo?: string;
  visibility?: "everyone" | "admins" | { people: string[] };
  voice?: string;
  speakReplies?: boolean;
  voiceNotes?: boolean;
  replyStyle?: "default" | "concise" | "detailed";
  /** Newest-first list of this agent's threads/tasks. Transient, reset on load. */
  tasks?: AgentTask[];
  /** Currently active thread id. */
  threadId?: string;
  /** Where a routine without its own thread reports. */
  mainThreadId?: string;
}

/** One task (thread) belonging to an agent. */
export interface AgentTask {
  id: string;
  threadId: string;
  title: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  agentId?: string;
  pinned: boolean;
  unread: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

/** Body for creating a new task/thread for an agent. */
export interface CreateAgentTaskInput {
  threadId: string;
  title: string;
  status?: "todo" | "in_progress" | "done" | "blocked";
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

/** Body for updating an agent's active thread. */
export interface UpdateAgentThreadInput {
  threadId?: string;
}

/** One conversational turn/message within a thread. */
export interface AgentThreadMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/** One declarative field in an agent's settings schema. */
export interface SettingsField {
  key: string;
  type: SettingsFieldType;
  label: string;
  description?: string;
  default?: any;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  secret?: boolean;
  placeholder?: string;
}

export type SettingsFieldType =
  | "select"
  | "number"
  | "toggle"
  | "secret"
  | "textarea"
  | "multiselect";

/** What the renderer may see about an agent in the sidecar roster. */
export interface AgentWithSettings extends AgentRecord {
  enabled: boolean;
  hasKey: boolean;
  lastValidatedAt?: number;
  validationError?: string | null;
  status: "enabled" | "disabled" | "error" | "unconfigured";
}

/** The full detail card view for one agent's settings. */
export interface AgentSettingsDetail extends AgentRecord {
  enabled: boolean;
  schema: SettingsField[];
  values: Record<string, any>;
  secretPlaceholder: string | null;
  lastValidatedAt?: number;
  validationError?: string | null;
  sessions: SessionSummary[];
}

/** Body for updating an agent's settings. */
export interface UpdateAgentSettingsInput {
  enabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  logoSvg?: string;
  logoColor?: string;
  predictedOutcome?: "positive" | "negative" | "uncertain" | "pending";
  observedOutcome?: "positive" | "negative" | "uncertain" | "pending";
}

/** Vault key reference stored alongside an agent (never the raw key). */
export interface AgentKeyReference {
  keyId: string;
  provider: string;
  lastValidatedAt?: number;
}

/** A snapshot of an agent's profile fields at a point in time. */
export interface AgentProfileSnapshot {
  name: string;
  role: string;
  systemPrompt: string;
  soul?: string;
  soulHash?: string;
  metadata?: Record<string, unknown>;
}

/** One recorded profile change (audit log entry). */
export interface AgentProfileChange {
  id: string;
  agentId: string;
  changedBy: "user" | "system" | "import";
  source: string; // "api" | "import" | "external"
  before: AgentProfileSnapshot;
  after: AgentProfileSnapshot;
  at: number;
}

/** Body for patching an agent's profile fields. */
export interface UpdateAgentProfileInput {
  name?: string;
  role?: string;
  systemPrompt?: string;
  soul?: string;
  avatarUrl?: string | null;
}

export interface AgentTemplate {
  templateVersion: string;
  name: string;
  role: string;
  description?: string;
  systemPrompt: string;
  kind?: "AGENT" | "ROOM";
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  metadata?: Record<string, unknown>;
  exportedAtMs: number;
}

/* ── Attachments ─────────────────────────────────────────────── */

export interface AttachmentRecord {
  id: string;
  filename: string;
  localPath: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  stagedAtMs: number;
}

/* ── Approvals / turn events ─────────────────────────────────── */

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  arguments: Record<string, any>;
  reason: string;
}

export type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export type ApprovalDecisionHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export type TurnPhase = "thinking" | "executing";

export type TurnEvent =
  | { type: "user_message"; content: string }
  | { type: "phase_started"; phase: TurnPhase; iteration: number; maxIterations: number }
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call_started"; toolCall: ToolCall }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "tool_call_completed"; toolCall: ToolCall; result: ToolExecutionResult }
  | { type: "turn_completed"; finalContent: string }
  | { type: "error"; error: Error }
  | { type: "subagent"; subagent: SubagentInfo; event: TurnEvent };

export type TurnEventListener = (event: TurnEvent) => void;

/**
 * Subagent delegation descriptor carried on every forwarded subagent
 * TurnEvent so the UI can route activity to the correct card and block
 * unbounded nesting. `depth` is 0 for a direct child of the main agent.
 */
export interface SubagentInfo {
  agentId: string;
  agentName: string;
  role?: string;
  /** Subagent turn session id: sub_<agentId>_<ts> */
  sessionId: string;
  task: string;
  depth: number;
  /** Parent subagent session id for nested delegations (undefined = direct child). */
  parentSessionId?: string;
}

/** A TurnEvent from a delegated subagent, wrapped with its identity. */
export interface SubagentTurnEvent {
  type: "subagent";
  subagent: SubagentInfo;
  event: TurnEvent;
}

/* ── LLM client config ───────────────────────────────────────── */

export interface LLMClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: "openai" | "anthropic" | "openrouter";
  thinkingBudgetTokens?: number;
  enablePromptCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  streamIdleTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/* ── Desktop / UI ────────────────────────────────────────────── */

export interface DesktopSettings {
  endpoint: string;
  model: string;
  apiKey?: string;
  autoApprove: boolean;
  provider: 'openai' | 'anthropic' | 'openrouter';
  theme: 'dark' | 'light' | 'system';
  maxContextTokens?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  agentId?: string;
  roomId?: string;
}

export type DesktopEventType =
  | 'session_started'
  | 'token'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'approval_required'
  | 'turn_complete'
  | 'turn_cancelled'
  | 'error'
  | 'status'
  | 'sentinel'
  | 'subagent';

export interface DesktopEvent {
  type: DesktopEventType;
  sessionId: string;
  data: unknown;
  /** Present on 'subagent' events: identity of the delegated agent. */
  subagent?: SubagentInfo;
}

/**
 * Turn-event listener with delegation context. When the coordinator
 * executes delegate_to_agent it threads `subagent` (sink + depth) into
 * the tool context so the child turn's events stream to the UI.
 */
export type DelegatedTurnEventListener =
  (event: TurnEvent, context: { subagent?: { onEvent: (e: TurnEvent) => void; depth: number } }) => void;
