// Pure model for the Bots & Templates view (Phase 5 Row 19).
// Mirrors the legacy renderer/app.js bots/templates controller without DOM or bridge code.

export interface AgentPersona {
  id: string;
  name: string;
  role?: string;
  systemPrompt?: string;
  model?: string;
  kind?: string;
  avatar?: string;
  allowedTools?: string[];
  [key: string]: unknown;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  priority?: "low" | "medium" | "high" | "urgent" | string;
  status?: "pending" | "in_progress" | "done" | string;
  agentId?: string;
  [key: string]: unknown;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  systemPrompt?: string;
  model?: string;
}

export interface CreateTaskInput {
  title: string;
  priority?: "low" | "medium" | "high" | "urgent" | string;
}

export interface AgentCardView {
  name: string;
  role: string;
  description: string;
  modelLabel: string;
  toolsLabel: string;
}

export interface BotItemView {
  id: string | null;
  name: string;
  role?: string;
  isActive: boolean;
  isDefault: boolean;
}

export interface TaskItemView {
  id: string;
  title: string;
  priority: string;
  isDone: boolean;
}

export interface BotsModalState {
  createBotModalOpen: boolean;
  createTaskModalOpen: boolean;
  exportTemplateModalOpen: boolean;
  importTemplateModalOpen: boolean;
}

export const BOT_VALIDATION_MESSAGE = "Please provide bot name and role.";
export const TASK_VALIDATION_MESSAGE = "Please provide a task title.";
export const TEMPLATES_EMPTY_STATE = "No agents registered. Create an agent persona first.";
export const TASKS_EMPTY_STATE = "No workspace tasks recorded yet.";
export const DEFAULT_ASSISTANT_NAME = "Default Assistant";

export function validateAgentInput(input: CreateAgentInput): string | null {
  if (!input.name?.trim() || !input.role?.trim()) {
    return BOT_VALIDATION_MESSAGE;
  }
  return null;
}

export function defaultSystemPrompt(name: string, role: string): string {
  return `You are ${name}. Assist the user with ${role}.`;
}

export function buildAgentPayload(input: CreateAgentInput): {
  name: string;
  role: string;
  systemPrompt: string;
  model?: string;
} {
  const name = input.name.trim();
  const role = input.role.trim();
  const systemPrompt = input.systemPrompt?.trim() || defaultSystemPrompt(name, role);
  const model = input.model?.trim() || undefined;
  return { name, role, systemPrompt, model };
}

export function validateTaskInput(input: CreateTaskInput): string | null {
  if (!input.title?.trim()) {
    return TASK_VALIDATION_MESSAGE;
  }
  return null;
}

export function validateImportTemplate(rawJson: string): {
  valid: boolean;
  error?: string;
  parsed?: unknown;
} {
  const trimmed = rawJson?.trim();
  if (!trimmed) {
    return { valid: false, error: "Please provide template JSON." };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return { valid: true, parsed };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}

export function agentCardView(agent: AgentPersona): AgentCardView {
  const name = agent.name || "";
  const role = agent.role || "";
  const prompt = agent.systemPrompt || "";
  const description = prompt.length > 120 ? `${prompt.slice(0, 120)}...` : prompt;
  const modelLabel = `Model: ${agent.model || "default"}`;
  const toolsLabel = `Tools: ${agent.allowedTools ? agent.allowedTools.length : "All"}`;
  return { name, role, description, modelLabel, toolsLabel };
}

export function botItemView(agent: AgentPersona | null, activeAgentId: string | null): BotItemView {
  if (!agent) {
    return {
      id: null,
      name: DEFAULT_ASSISTANT_NAME,
      role: undefined,
      isActive: activeAgentId === null,
      isDefault: true,
    };
  }
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    isActive: activeAgentId === agent.id,
    isDefault: false,
  };
}

export function taskItemView(task: WorkspaceTask): TaskItemView {
  return {
    id: task.id,
    title: task.title || "",
    priority: task.priority || "medium",
    isDone: task.status === "done",
  };
}

export function createInitialModalState(): BotsModalState {
  return {
    createBotModalOpen: false,
    createTaskModalOpen: false,
    exportTemplateModalOpen: false,
    importTemplateModalOpen: false,
  };
}

export function openCreateBotModal(state: BotsModalState): BotsModalState {
  return { ...state, createBotModalOpen: true };
}

export function closeCreateBotModal(state: BotsModalState): BotsModalState {
  return { ...state, createBotModalOpen: false };
}

export function openCreateTaskModal(state: BotsModalState): BotsModalState {
  return { ...state, createTaskModalOpen: true };
}

export function closeCreateTaskModal(state: BotsModalState): BotsModalState {
  return { ...state, createTaskModalOpen: false };
}

export function openExportTemplateModal(state: BotsModalState): BotsModalState {
  return { ...state, exportTemplateModalOpen: true };
}

export function closeExportTemplateModal(state: BotsModalState): BotsModalState {
  return { ...state, exportTemplateModalOpen: false };
}

export function openImportTemplateModal(state: BotsModalState): BotsModalState {
  return { ...state, importTemplateModalOpen: true };
}

export function closeImportTemplateModal(state: BotsModalState): BotsModalState {
  return { ...state, importTemplateModalOpen: false };
}

export function closeAllModals(state: BotsModalState): BotsModalState {
  return {
    createBotModalOpen: false,
    createTaskModalOpen: false,
    exportTemplateModalOpen: false,
    importTemplateModalOpen: false,
  };
}
