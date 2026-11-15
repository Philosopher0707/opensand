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

/** A missing or broken timestamp must not make a comparison NaN: the order has to be total. */
function stamp(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}


let taskSeq = 0;
let lastTimestamp = 0;

function nextTaskId(now: number): string {
  if (now === lastTimestamp) {
    taskSeq++;
  } else {
    lastTimestamp = now;
    taskSeq = 0;
  }
  return `task_${now}_${String(taskSeq).padStart(4, "0")}`;
}

export class TaskStore {
  static resetSequenceForTesting(): void {
    lastTimestamp = 0;
    taskSeq = 0;
  }

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

    const now = Date.now();
    const id = nextTaskId(now);

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
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return null;
    }
    await this.ensureDirectory();
    const filePath = path.join(this.baseDir, `${id}.json`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.baseDir))) {
      return null;
    }
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
        // Same updatedAt: fall back to creation, then to the id. Without this the
        // order of a tie was the filesystem's, so it changed between runs.
        const byUpdated = stamp(b.updatedAt) - stamp(a.updatedAt);
        if (byUpdated !== 0) return byUpdated;
        const byCreated = stamp(b.createdAt) - stamp(a.createdAt);
        if (byCreated !== 0) return byCreated;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return false;
    }
    const filePath = path.join(this.baseDir, `${id}.json`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.baseDir))) {
      return false;
    }
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
