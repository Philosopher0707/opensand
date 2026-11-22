import test from "node:test";
import assert from "node:assert";
import {
  BOT_VALIDATION_MESSAGE,
  TASK_VALIDATION_MESSAGE,
  TEMPLATES_EMPTY_STATE,
  TASKS_EMPTY_STATE,
  DEFAULT_ASSISTANT_NAME,
  validateAgentInput,
  defaultSystemPrompt,
  buildAgentPayload,
  validateTaskInput,
  validateImportTemplate,
  agentCardView,
  botItemView,
  taskItemView,
  createInitialModalState,
  openCreateBotModal,
  closeCreateBotModal,
  openCreateTaskModal,
  closeCreateTaskModal,
  openExportTemplateModal,
  closeExportTemplateModal,
  openImportTemplateModal,
  closeImportTemplateModal,
  closeAllModals,
  type AgentPersona,
  type WorkspaceTask,
  type CreateAgentInput,
  type CreateTaskInput,
} from "../src/shell/bots-model.js";

test("validateAgentInput: requires non-empty name and role", () => {
  assert.strictEqual(validateAgentInput({ name: "", role: "Engineer" }), BOT_VALIDATION_MESSAGE);
  assert.strictEqual(validateAgentInput({ name: "   ", role: "Engineer" }), BOT_VALIDATION_MESSAGE);
  assert.strictEqual(validateAgentInput({ name: "CTO", role: "" }), BOT_VALIDATION_MESSAGE);
  assert.strictEqual(validateAgentInput({ name: "CTO", role: "   " }), BOT_VALIDATION_MESSAGE);
  assert.strictEqual(validateAgentInput({ name: "CTO", role: "Architect" }), null);
});

test("defaultSystemPrompt: builds deterministic prompt from name and role", () => {
  const prompt = defaultSystemPrompt("CTO Bot", "System Architecture");
  assert.strictEqual(prompt, "You are CTO Bot. Assist the user with System Architecture.");
});

test("buildAgentPayload: trims fields and generates default prompt or preserves custom prompt", () => {
  const payload1 = buildAgentPayload({
    name: "  Pixel  ",
    role: "  Frontend Engineer  ",
  });
  assert.deepStrictEqual(payload1, {
    name: "Pixel",
    role: "Frontend Engineer",
    systemPrompt: "You are Pixel. Assist the user with Frontend Engineer.",
    model: undefined,
  });

  const payload2 = buildAgentPayload({
    name: "Ada",
    role: "AI Architect",
    systemPrompt: "Custom prompt here.",
    model: "  claude-3-7-sonnet  ",
  });
  assert.deepStrictEqual(payload2, {
    name: "Ada",
    role: "AI Architect",
    systemPrompt: "Custom prompt here.",
    model: "claude-3-7-sonnet",
  });
});

test("validateTaskInput: requires title", () => {
  assert.strictEqual(validateTaskInput({ title: "" }), TASK_VALIDATION_MESSAGE);
  assert.strictEqual(validateTaskInput({ title: "   " }), TASK_VALIDATION_MESSAGE);
  assert.strictEqual(validateTaskInput({ title: "Implement Row 19" }), null);
});

test("validateImportTemplate: validates JSON string and reports errors", () => {
  const emptyRes = validateImportTemplate("");
  assert.strictEqual(emptyRes.valid, false);
  assert.strictEqual(emptyRes.error, "Please provide template JSON.");

  const invalidRes = validateImportTemplate("{ broken json ");
  assert.strictEqual(invalidRes.valid, false);
  assert.ok(invalidRes.error);

  const validJson = JSON.stringify({ version: "1.0", agent: { name: "Bot1", role: "Worker" } });
  const validRes = validateImportTemplate(validJson);
  assert.strictEqual(validRes.valid, true);
  assert.deepStrictEqual(validRes.parsed, { version: "1.0", agent: { name: "Bot1", role: "Worker" } });
});

test("agentCardView: computes description snippet, model, and tools label", () => {
  const shortAgent: AgentPersona = {
    id: "agent-1",
    name: "Shorty",
    role: "Helper",
    systemPrompt: "Short instructions.",
  };
  const shortView = agentCardView(shortAgent);
  assert.deepStrictEqual(shortView, {
    name: "Shorty",
    role: "Helper",
    description: "Short instructions.",
    modelLabel: "Model: default",
    toolsLabel: "Tools: All",
  });

  const longPrompt = "A".repeat(150);
  const fullAgent: AgentPersona = {
    id: "agent-2",
    name: "Specialist",
    role: "Security",
    systemPrompt: longPrompt,
    model: "qwen3:8b",
    allowedTools: ["read_file", "search_web"],
  };
  const fullView = agentCardView(fullAgent);
  assert.strictEqual(fullView.name, "Specialist");
  assert.strictEqual(fullView.role, "Security");
  assert.strictEqual(fullView.description, "A".repeat(120) + "...");
  assert.strictEqual(fullView.modelLabel, "Model: qwen3:8b");
  assert.strictEqual(fullView.toolsLabel, "Tools: 2");
});

test("botItemView: handles default assistant and registered bots with active state", () => {
  const defaultInactive = botItemView(null, "some-bot-id");
  assert.deepStrictEqual(defaultInactive, {
    id: null,
    name: DEFAULT_ASSISTANT_NAME,
    role: undefined,
    isActive: false,
    isDefault: true,
  });

  const defaultActive = botItemView(null, null);
  assert.strictEqual(defaultActive.isActive, true);

  const bot: AgentPersona = { id: "bot-10", name: "Gump", role: "CTO" };
  const botActive = botItemView(bot, "bot-10");
  assert.deepStrictEqual(botActive, {
    id: "bot-10",
    name: "Gump",
    role: "CTO",
    isActive: true,
    isDefault: false,
  });

  const botInactive = botItemView(bot, "other-bot");
  assert.strictEqual(botInactive.isActive, false);
});

test("taskItemView: formats title, priority, and completion status", () => {
  const pendingTask: WorkspaceTask = {
    id: "task-1",
    title: "Draft PR",
    priority: "urgent",
    status: "in_progress",
  };
  assert.deepStrictEqual(taskItemView(pendingTask), {
    id: "task-1",
    title: "Draft PR",
    priority: "urgent",
    isDone: false,
  });

  const doneTask: WorkspaceTask = {
    id: "task-2",
    title: "Merge PR",
    status: "done",
  };
  assert.deepStrictEqual(taskItemView(doneTask), {
    id: "task-2",
    title: "Merge PR",
    priority: "medium",
    isDone: true,
  });
});

test("modal state machine: toggles all modals and resets", () => {
  let state = createInitialModalState();
  assert.deepStrictEqual(state, {
    createBotModalOpen: false,
    createTaskModalOpen: false,
    exportTemplateModalOpen: false,
    importTemplateModalOpen: false,
  });

  state = openCreateBotModal(state);
  assert.strictEqual(state.createBotModalOpen, true);
  state = closeCreateBotModal(state);
  assert.strictEqual(state.createBotModalOpen, false);

  state = openCreateTaskModal(state);
  assert.strictEqual(state.createTaskModalOpen, true);
  state = closeCreateTaskModal(state);
  assert.strictEqual(state.createTaskModalOpen, false);

  state = openExportTemplateModal(state);
  assert.strictEqual(state.exportTemplateModalOpen, true);
  state = closeExportTemplateModal(state);
  assert.strictEqual(state.exportTemplateModalOpen, false);

  state = openImportTemplateModal(state);
  assert.strictEqual(state.importTemplateModalOpen, true);
  state = closeImportTemplateModal(state);
  assert.strictEqual(state.importTemplateModalOpen, false);

  state = openCreateBotModal(state);
  state = openCreateTaskModal(state);
  state = openExportTemplateModal(state);
  state = openImportTemplateModal(state);
  const reset = closeAllModals(state);
  assert.deepStrictEqual(reset, createInitialModalState());
});

test("constant strings match requirements", () => {
  assert.strictEqual(TEMPLATES_EMPTY_STATE, "No agents registered. Create an agent persona first.");
  assert.strictEqual(TASKS_EMPTY_STATE, "No workspace tasks recorded yet.");
});
