import type {
  AgentPersona,
  WorkspaceTask,
  CreateAgentInput,
  CreateTaskInput,
} from "../../../src/shell/bots-model";
import { buildAgentPayload } from "../../../src/shell/bots-model";

export interface BotsData {
  getBots(): Promise<AgentPersona[]>;
  getAgents(): Promise<AgentPersona[]>;
  createBot(payload: CreateAgentInput): Promise<AgentPersona>;
  createAgent(payload: CreateAgentInput): Promise<AgentPersona>;
  deleteBot(agentId: string): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  getTasks(): Promise<WorkspaceTask[]>;
  getWorkspaceTasks(): Promise<WorkspaceTask[]>;
  createTask(payload: CreateTaskInput): Promise<WorkspaceTask>;
  createWorkspaceTask(payload: CreateTaskInput): Promise<WorkspaceTask>;
  exportAgentTemplate(agentId: string): Promise<unknown>;
  exportBotTemplate(agentId: string): Promise<unknown>;
  importAgentTemplate(template: unknown): Promise<AgentPersona>;
  importBotTemplate(template: unknown): Promise<AgentPersona>;
}

export function botsData(bridge?: any, http?: typeof fetch): BotsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);

  const getAgents = async (): Promise<AgentPersona[]> => {
    if (typeof window !== "undefined") {
      if ((window as any).__testBots !== undefined) {
        return (window as any).__testBots;
      }
      if ((window as any).__testAgents !== undefined) {
        return (window as any).__testAgents;
      }
    }
    const b = getBridge();
    if (b?.getAgents) {
      try {
        const res = await b.getAgents();
        if (Array.isArray(res)) return res;
      } catch {
        // fall through to HTTP route
      }
    }
    try {
      const res = http ? await http("/api/agents") : await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }
    } catch {
      // Fallback when fetch route is not available
    }
    return [];
  };

  const createAgent = async (payload: CreateAgentInput): Promise<AgentPersona> => {
    const formatted = buildAgentPayload(payload);
    const b = getBridge();
    if (b?.createAgent) {
      try {
        return await b.createAgent(formatted);
      } catch {
        // fall through to HTTP route
      }
    }
    const res = http
      ? await http("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formatted),
        })
      : await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formatted),
        });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Could not create bot (HTTP ${res.status})`);
    }
    return data as AgentPersona;
  };

  const deleteAgent = async (agentId: string): Promise<void> => {
    if (typeof window !== "undefined") {
      if (Array.isArray((window as any).__testBots)) {
        (window as any).__testBots = (window as any).__testBots.filter((b: any) => b.id !== agentId);
      }
      if (Array.isArray((window as any).__testAgents)) {
        (window as any).__testAgents = (window as any).__testAgents.filter((b: any) => b.id !== agentId);
      }
    }
    const b = getBridge();
    if (b?.deleteAgent) {
      try {
        await b.deleteAgent(agentId);
        return;
      } catch {
        // fall through to HTTP route
      }
    }
    const res = http
      ? await http(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })
      : await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `Could not delete bot (HTTP ${res.status})`);
    }
  };

  const getTasks = async (): Promise<WorkspaceTask[]> => {
    if (typeof window !== "undefined" && (window as any).__testTasks !== undefined) {
      return (window as any).__testTasks;
    }
    const b = getBridge();
    if (b?.getTasks) {
      try {
        const res = await b.getTasks();
        if (Array.isArray(res)) return res;
      } catch {
        // fall through to HTTP route
      }
    }
    try {
      const res = http ? await http("/api/tasks") : await fetch("/api/tasks");
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }
    } catch {
      // Fallback when fetch route is not available
    }
    return [];
  };

  const createTask = async (payload: CreateTaskInput): Promise<WorkspaceTask> => {
    const b = getBridge();
    if (b?.createTask) {
      try {
        return await b.createTask(payload);
      } catch {
        // fall through to HTTP route
      }
    }
    const res = http
      ? await http("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Could not create task (HTTP ${res.status})`);
    }
    return data as WorkspaceTask;
  };

  const exportAgentTemplate = async (agentId: string): Promise<unknown> => {
    const b = getBridge();
    if (b?.exportAgentTemplate) {
      try {
        return await b.exportAgentTemplate(agentId);
      } catch {
        // fall through to HTTP route
      }
    }
    const res = http
      ? await http(`/api/templates/${encodeURIComponent(agentId)}`)
      : await fetch(`/api/templates/${encodeURIComponent(agentId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Could not export template (HTTP ${res.status})`);
    }
    return data;
  };

  const importAgentTemplate = async (template: unknown): Promise<AgentPersona> => {
    const b = getBridge();
    if (b?.importAgentTemplate) {
      try {
        return await b.importAgentTemplate(template);
      } catch {
        // fall through to HTTP route
      }
    }
    const body = typeof template === "string" ? template : JSON.stringify(template);
    const res = http
      ? await http("/api/templates/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      : await fetch("/api/templates/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Could not import template (HTTP ${res.status})`);
    }
    return data as AgentPersona;
  };

  return {
    getBots: getAgents,
    getAgents,
    createBot: createAgent,
    createAgent,
    deleteBot: deleteAgent,
    deleteAgent,
    getTasks,
    getWorkspaceTasks: getTasks,
    createTask,
    createWorkspaceTask: createTask,
    exportAgentTemplate,
    exportBotTemplate: exportAgentTemplate,
    importAgentTemplate,
    importBotTemplate: importAgentTemplate,
  };
}
