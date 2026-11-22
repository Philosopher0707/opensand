// Bots and Templates View (Phase 5 Row 19).
// Replaces the #viewTemplates legacy stub with Preact cards, persona roster, task manager, and template modals.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  BOT_VALIDATION_MESSAGE,
  TASK_VALIDATION_MESSAGE,
  TEMPLATES_EMPTY_STATE,
  TASKS_EMPTY_STATE,
  DEFAULT_ASSISTANT_NAME,
  type AgentPersona,
  type WorkspaceTask,
  type BotsModalState,
  validateAgentInput,
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
} from "../../../src/shell/bots-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface BotsViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function BotsView({ data, active, onSelect, refreshKey }: BotsViewProps) {
  const [agents, setAgents] = useState<AgentPersona[]>([]);
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState<BotsModalState>(createInitialModalState);

  // Create Bot Modal State
  const [botName, setBotName] = useState("");
  const [botRole, setBotRole] = useState("");
  const [botSystemPrompt, setBotSystemPrompt] = useState("");
  const [botModel, setBotModel] = useState("");
  const [botFormError, setBotFormError] = useState<string | null>(null);
  const [savingBot, setSavingBot] = useState(false);

  // Create Task Modal State
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPriority, setTaskPriority] = useState<string>("medium");
  const [taskFormError, setTaskFormError] = useState<string | null>(null);
  const [savingTask, setSavingTask] = useState(false);

  // Export Template Modal State
  const [selectedExportBotId, setSelectedExportBotId] = useState("");
  const [exportTemplateJson, setExportTemplateJson] = useState("Click Generate Template");
  const [generatingExport, setGeneratingExport] = useState(false);

  // Import Template Modal State
  const [importTemplateJson, setImportTemplateJson] = useState("");
  const [importFormError, setImportFormError] = useState<string | null>(null);
  const [importingTemplate, setImportingTemplate] = useState(false);

  const reload = async () => {
    try {
      const [botList, taskList] = await Promise.all([
        data.getAgents ? data.getAgents() : data.getBots(),
        data.getTasks ? data.getTasks() : data.getWorkspaceTasks(),
      ]);
      setAgents(Array.isArray(botList) ? botList : []);
      setTasks(Array.isArray(taskList) ? taskList : []);
    } catch {
      // Keep existing data on reload error
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [botList, taskList] = await Promise.all([
          data.getAgents ? data.getAgents() : data.getBots(),
          data.getTasks ? data.getTasks() : data.getWorkspaceTasks(),
        ]);
        if (cancelled) return;
        setAgents(Array.isArray(botList) ? botList : []);
        setTasks(Array.isArray(taskList) ? taskList : []);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, refreshKey, active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      setModals(closeAllModals);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Update default selected bot for export if not set
  useEffect(() => {
    if (!selectedExportBotId && agents.length > 0) {
      setSelectedExportBotId(agents[0].id);
    }
  }, [agents, selectedExportBotId]);

  // Modal Open Handlers
  const handleOpenCreateBot = () => {
    setBotName("");
    setBotRole("");
    setBotSystemPrompt("");
    setBotModel("");
    setBotFormError(null);
    setModals(openCreateBotModal);
  };

  const handleOpenCreateTask = () => {
    setTaskTitle("");
    setTaskPriority("medium");
    setTaskFormError(null);
    setModals(openCreateTaskModal);
  };

  const handleOpenExportTemplate = () => {
    if (agents.length > 0 && !selectedExportBotId) {
      setSelectedExportBotId(agents[0].id);
    }
    setExportTemplateJson("Click Generate Template");
    setModals(openExportTemplateModal);
  };

  const handleOpenImportTemplate = () => {
    setImportTemplateJson("");
    setImportFormError(null);
    setModals(openImportTemplateModal);
  };

  // Card Export Click Handler
  const handleExportCard = async (agentId: string) => {
    setSelectedExportBotId(agentId);
    setModals(openExportTemplateModal);
    try {
      const tpl = await (data.exportAgentTemplate ? data.exportAgentTemplate(agentId) : data.exportBotTemplate(agentId));
      setExportTemplateJson(JSON.stringify(tpl, null, 2));
    } catch (err) {
      setExportTemplateJson(`Error: ${errorMessage(err)}`);
    }
  };

  // Action: Save Bot
  const handleSaveBot = async () => {
    const err = validateAgentInput({ name: botName, role: botRole });
    if (err) {
      setBotFormError(err);
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(err);
      }
      return;
    }
    setSavingBot(true);
    setBotFormError(null);
    try {
      await (data.createAgent
        ? data.createAgent({
            name: botName,
            role: botRole,
            systemPrompt: botSystemPrompt,
            model: botModel,
          })
        : data.createBot({
            name: botName,
            role: botRole,
            systemPrompt: botSystemPrompt,
            model: botModel,
          }));
      setModals(closeCreateBotModal);
      await reload();
    } catch (saveErr) {
      setBotFormError(errorMessage(saveErr));
    } finally {
      setSavingBot(false);
    }
  };

  // Action: Save Task
  const handleSaveTask = async () => {
    const err = validateTaskInput({ title: taskTitle });
    if (err) {
      setTaskFormError(err);
      return;
    }
    setSavingTask(true);
    setTaskFormError(null);
    try {
      await (data.createTask
        ? data.createTask({
            title: taskTitle,
            priority: taskPriority,
          })
        : data.createWorkspaceTask({
            title: taskTitle,
            priority: taskPriority,
          }));
      setModals(closeCreateTaskModal);
      await reload();
    } catch (saveErr) {
      setTaskFormError(errorMessage(saveErr));
    } finally {
      setSavingTask(false);
    }
  };

  // Action: Delete Bot
  const handleDeleteBot = async (agent: AgentPersona) => {
    const confirmed = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm(`Are you sure you want to delete bot "${agent.name}"?`)
      : true;
    if (!confirmed) return;

    try {
      await (data.deleteAgent ? data.deleteAgent(agent.id) : data.deleteBot(agent.id));
      if (activeAgentId === agent.id) {
        setActiveAgentId(null);
      }
      await reload();
    } catch (err) {
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(`Could not delete bot: ${errorMessage(err)}`);
      }
    }
  };

  // Action: Generate Export Template
  const handleGenerateExportTemplate = async () => {
    if (!selectedExportBotId) return;
    setGeneratingExport(true);
    try {
      const tpl = await (data.exportAgentTemplate
        ? data.exportAgentTemplate(selectedExportBotId)
        : data.exportBotTemplate(selectedExportBotId));
      setExportTemplateJson(JSON.stringify(tpl, null, 2));
    } catch (err) {
      setExportTemplateJson(`Error: ${errorMessage(err)}`);
    } finally {
      setGeneratingExport(false);
    }
  };

  // Action: Copy Export Template
  const handleCopyExportTemplate = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(exportTemplateJson);
    }
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert("Template JSON copied to clipboard.");
    }
  };

  // Action: Confirm Import Template
  const handleConfirmImportTemplate = async () => {
    const validation = validateImportTemplate(importTemplateJson);
    if (!validation.valid) {
      setImportFormError(validation.error || "Invalid template JSON");
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(`Invalid template JSON: ${validation.error}`);
      }
      return;
    }
    setImportingTemplate(true);
    setImportFormError(null);
    try {
      await (data.importAgentTemplate
        ? data.importAgentTemplate(validation.parsed)
        : data.importBotTemplate(validation.parsed));
      setModals(closeImportTemplateModal);
      await reload();
    } catch (err) {
      const msg = errorMessage(err);
      setImportFormError(msg);
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(`Invalid template JSON: ${msg}`);
      }
    } finally {
      setImportingTemplate(false);
    }
  };

  const botsGroup = NAV_GROUPS.find((group) => group.id === "templates");

  return (
    <div id={viewPanelId("templates")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container bots-view-container">
        {botsGroup && (
          <nav class="subnav-tabs" data-group={botsGroup.id} aria-label="Bots views">
            {botsGroup.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "templates" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "templates" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">Bots & Personas</div>
            <div class="dashboard-subtitle">
              Configure autonomous agent personas, custom system instructions, tool whitelists, and template exports.
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button id="btnOpenCreateBot" type="button" class="btn btn-primary" onClick={handleOpenCreateBot}>
              + New Persona
            </button>
            <button id="btnOpenExportTemplate" type="button" class="btn btn-secondary" onClick={handleOpenExportTemplate}>
              Export Template
            </button>
            <button id="btnOpenImportTemplate" type="button" class="btn btn-secondary" onClick={handleOpenImportTemplate}>
              Import Template
            </button>
          </div>
        </div>

        {loadError && (
          <div class="bots-error" role="alert">
            <span>Could not load bots: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>
              Retry
            </button>
          </div>
        )}

        {/* Section 1: Active Persona Roster */}
        <div class="sidebar-section-title" style="margin-top: 14px;">
          Active Persona Roster
        </div>
        <div class="bot-list compact" id="botList">
          {/* Default Assistant */}
          {(() => {
            const defaultItem = botItemView(null, activeAgentId);
            return (
              <div
                class={`bot-item ${defaultItem.isActive ? "active" : ""}`}
                onClick={() => setActiveAgentId(null)}
              >
                <span class="bot-icon">🤖</span>
                <div class="bot-item-info">
                  <span class="bot-item-name">{DEFAULT_ASSISTANT_NAME}</span>
                </div>
              </div>
            );
          })()}

          {/* Registered Personas */}
          {agents.map((agent) => {
            const item = botItemView(agent, activeAgentId);
            return (
              <div
                key={agent.id}
                class={`bot-item ${item.isActive ? "active" : ""}`}
                title={agent.role || agent.name}
                onClick={() => setActiveAgentId(agent.id)}
              >
                <span class="bot-icon">⚡</span>
                <div class="bot-item-info">
                  <span class="bot-item-name">{item.name}</span>
                  {item.role && <span class="bot-item-role">{item.role}</span>}
                </div>
                <button
                  type="button"
                  class="btn-delete-bot"
                  title="Delete bot"
                  data-bot-id={agent.id}
                  aria-label="Delete bot"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeleteBot(agent);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>

        {/* Section 2: Active Workspace Tasks */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", marginBottom: "8px" }}>
          <div class="sidebar-section-title" style="margin: 0;">
            Active Workspace Tasks
          </div>
          <button id="btnOpenCreateTask" type="button" class="btn btn-ghost btn-xs" onClick={handleOpenCreateTask}>
            + Add Task
          </button>
        </div>
        <div class="task-list compact" id="taskList">
          {tasks.length === 0 ? (
            <div class="tasks-empty">{TASKS_EMPTY_STATE}</div>
          ) : (
            tasks.map((task) => {
              const item = taskItemView(task);
              return (
                <div key={task.id} class={`task-item ${item.isDone ? "done" : ""}`}>
                  <span class="task-title">{item.title}</span>
                  <span class={`badge badge-priority badge-${item.priority}`}>{item.priority}</span>
                </div>
              );
            })
          )}
        </div>

        {/* Section 3: Available Agent Personas for Template Generation */}
        <div class="sidebar-section-title" style="margin-top: 16px;">
          Available Agent Personas for Template Generation
        </div>
        <div class="card-grid" id="templateAgentsGrid">
          {loading ? (
            <div class="bots-loading">Loading personas…</div>
          ) : agents.length === 0 ? (
            <div class="templates-empty">{TEMPLATES_EMPTY_STATE}</div>
          ) : (
            agents.map((agent) => {
              const card = agentCardView(agent);
              return (
                <div class="dashboard-card agent-template-card" key={agent.id}>
                  <div class="card-top">
                    <div class="card-title">{card.name}</div>
                    <span class="badge badge-bot">{card.role}</span>
                  </div>
                  <div class="card-desc">{card.description}</div>
                  <div class="card-meta">
                    <span class="badge">{card.modelLabel}</span>
                    <span class="badge">{card.toolsLabel}</span>
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-secondary btn-xs btn-export-agent"
                      onClick={() => void handleExportCard(agent.id)}
                    >
                      Export Template
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost btn-xs btn-del-agent"
                      style="color: var(--danger);"
                      onClick={() => void handleDeleteBot(agent)}
                    >
                      Delete Bot
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Modal 1: Create Bot Modal */}
      <div
        id="createBotModal"
        class={`modal-overlay${modals.createBotModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createBotModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createBotModalTitle">Create Autonomous Bot</h3>
            <button
              id="btnCloseCreateBot"
              type="button"
              class="btn-close"
              aria-label="Close create bot dialog"
              onClick={() => setModals(closeCreateBotModal)}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="botName">Bot Name</label>
              <input
                type="text"
                id="botName"
                class="form-control"
                placeholder="e.g. CTO Bot, Security Auditor"
                value={botName}
                onInput={(e) => setBotName((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="botRole">Role / Title</label>
              <input
                type="text"
                id="botRole"
                class="form-control"
                placeholder="e.g. Chief Technology Officer"
                value={botRole}
                onInput={(e) => setBotRole((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="botSystemPrompt">System Prompt & Instructions</label>
              <textarea
                id="botSystemPrompt"
                class="form-control"
                rows={4}
                placeholder="You are the CTO bot. Provide high-level architectural oversight..."
                value={botSystemPrompt}
                onInput={(e) => setBotSystemPrompt((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="botModel">Model Override (optional)</label>
              <input
                type="text"
                id="botModel"
                class="form-control"
                placeholder="e.g. qwen3:8b, claude-3-7-sonnet"
                value={botModel}
                onInput={(e) => setBotModel((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            {botFormError && (
              <div id="createBotFormError" class="bots-form-error" role="alert">
                {botFormError}
              </div>
            )}
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveBot"
              type="button"
              class="btn btn-primary"
              disabled={savingBot}
              onClick={() => void handleSaveBot()}
            >
              {savingBot ? "Registering..." : "Register Bot"}
            </button>
          </div>
        </div>
      </div>

      {/* Modal 2: Create Task Modal */}
      <div
        id="createTaskModal"
        class={`modal-overlay${modals.createTaskModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createTaskModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createTaskModalTitle">Add Agent Task / Milestone</h3>
            <button
              id="btnCloseCreateTask"
              type="button"
              class="btn-close"
              aria-label="Close create task dialog"
              onClick={() => setModals(closeCreateTaskModal)}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="taskTitle">Task Title</label>
              <input
                type="text"
                id="taskTitle"
                class="form-control"
                placeholder="e.g. Refactor command runner"
                value={taskTitle}
                onInput={(e) => setTaskTitle((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="taskPriority">Priority</label>
              <select
                id="taskPriority"
                class="form-control"
                value={taskPriority}
                onChange={(e) => setTaskPriority((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            {taskFormError && (
              <div id="createTaskFormError" class="bots-form-error" role="alert">
                {taskFormError}
              </div>
            )}
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveTask"
              type="button"
              class="btn btn-primary"
              disabled={savingTask}
              onClick={() => void handleSaveTask()}
            >
              {savingTask ? "Saving..." : "Save Task"}
            </button>
          </div>
        </div>
      </div>

      {/* Modal 3: Export Template Modal */}
      <div
        id="exportTemplateModal"
        class={`modal-overlay${modals.exportTemplateModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exportTemplateModalTitle"
      >
        <div class="modal-card" style="max-width: 600px;">
          <div class="modal-header">
            <h3 id="exportTemplateModalTitle">📋 Export Agent Persona Template</h3>
            <button
              id="btnCloseExportTemplate"
              type="button"
              class="btn-close"
              aria-label="Close export template dialog"
              onClick={() => setModals(closeExportTemplateModal)}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="selectExportBot">Select Agent to Export</label>
              <select
                id="selectExportBot"
                class="form-control"
                value={selectedExportBotId}
                onChange={(e) => setSelectedExportBotId((e.currentTarget as HTMLSelectElement).value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role || "Specialist"})
                  </option>
                ))}
              </select>
            </div>
            <div class="form-group">
              <label>Generated Template JSON</label>
              <pre class="markdown-viewer" id="exportTemplateJson">
                {exportTemplateJson}
              </pre>
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnGenerateExportTemplate"
              type="button"
              class="btn btn-primary"
              disabled={generatingExport || !selectedExportBotId}
              onClick={() => void handleGenerateExportTemplate()}
            >
              {generatingExport ? "Generating..." : "Generate Template"}
            </button>
            <button
              id="btnCopyExportTemplate"
              type="button"
              class="btn btn-secondary"
              onClick={handleCopyExportTemplate}
            >
              Copy JSON
            </button>
          </div>
        </div>
      </div>

      {/* Modal 4: Import Template Modal */}
      <div
        id="importTemplateModal"
        class={`modal-overlay${modals.importTemplateModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="importTemplateModalTitle"
      >
        <div class="modal-card" style="max-width: 600px;">
          <div class="modal-header">
            <h3 id="importTemplateModalTitle">📋 Import Agent Persona Template</h3>
            <button
              id="btnCloseImportTemplate"
              type="button"
              class="btn-close"
              aria-label="Close import template dialog"
              onClick={() => setModals(closeImportTemplateModal)}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="importTemplateJson">Template JSON</label>
              <textarea
                id="importTemplateJson"
                class="form-control"
                rows={8}
                placeholder='{"version":"1.0","agent":{"name":"CTO","role":"Architect",...}}'
                value={importTemplateJson}
                onInput={(e) => setImportTemplateJson((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            {importFormError && (
              <div id="importTemplateFormError" class="bots-form-error" role="alert">
                {importFormError}
              </div>
            )}
          </div>
          <div class="modal-actions">
            <button
              id="btnConfirmImportTemplate"
              type="button"
              class="btn btn-primary"
              disabled={importingTemplate}
              onClick={() => void handleConfirmImportTemplate()}
            >
              {importingTemplate ? "Importing..." : "Import Agent Persona"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
