import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  agentId?: string;
  pinned: boolean;
  read: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  agentId?: string;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

export class TaskStore {
  private baseDir: string;

  constructor(customDir?: string) {
    this.baseDir = customDir ?? path.join(os.homedir(), ".opensand", "tasks");
  }

  get storageDirectory(): string {
    return this.baseDir;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    await this.ensureDirectory();

    const rand = crypto.randomBytes(4).toString("hex");
    const id = `task_${Date.now()}_${rand}`;
    const now = Date.now();

    const task: AgentTask = {
      id,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      agentId: input.agentId,
      pinned: input.pinned ?? false,
      read: false,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    await this.saveTaskAtomic(task);
    return task;
  }

  async getTask(id: string): Promise<AgentTask | null> {
    await this.ensureDirectory();
    const filePath = path.join(this.baseDir, `${id}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as AgentTask;
    } catch {
      return null;
    }
  }

  async listTasks(filter?: { status?: TaskStatus; agentId?: string }): Promise<AgentTask[]> {
    await this.ensureDirectory();

    try {
      const files = await fs.readdir(this.baseDir);
      const tasks: AgentTask[] = [];

      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        try {
          const filePath = path.join(this.baseDir, file);
          const raw = await fs.readFile(filePath, "utf-8");
          const task = JSON.parse(raw) as AgentTask;
          if (task && task.id && task.title) {
            if (filter?.status && task.status !== filter.status) continue;
            if (filter?.agentId && task.agentId !== filter.agentId) continue;
            tasks.push(task);
          }
        } catch {
          // Skip corrupted
        }
      }

      return tasks.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
    } catch {
      return [];
    }
  }

  async updateTask(id: string, updates: Partial<Omit<AgentTask, "id" | "createdAt">>): Promise<AgentTask> {
    const existing = await this.getTask(id);
    if (!existing) {
      throw new Error(`Task [${id}] not found`);
    }

    const now = Date.now();
    const updated: AgentTask = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      completedAt: updates.status === "done" && existing.status !== "done" ? now : existing.completedAt,
    };

    await this.saveTaskAtomic(updated);
    return updated;
  }

  async deleteTask(id: string): Promise<boolean> {
    const filePath = path.join(this.baseDir, `${id}.json`);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async saveTaskAtomic(task: AgentTask): Promise<void> {
    const targetPath = path.join(this.baseDir, `${task.id}.json`);
    const tempPath = path.join(this.baseDir, `.${task.id}.${Date.now()}.tmp`);
    const content = JSON.stringify(task, null, 2);

    try {
      await fs.writeFile(tempPath, content, { mode: 0o600 });
      await fs.rename(tempPath, targetPath);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }
}
