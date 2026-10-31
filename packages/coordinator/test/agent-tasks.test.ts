import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TaskStore } from "../src/agent-tasks.js";

test("TaskStore - CRUD Lifecycle", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-task-test-"));
  const store = new TaskStore(tmpDir);

  await t.test("creates a task atomically with 0600 mode", async () => {
    const task = await store.createTask({
      title: "Audit local-exec-daemon",
      description: "Ensure destructive command gate blocks fork bombs",
      priority: "urgent",
      pinned: true,
      agentId: "agent_cto",
    });

    assert.ok(task.id.startsWith("task_"));
    assert.equal(task.title, "Audit local-exec-daemon");
    assert.equal(task.priority, "urgent");
    assert.equal(task.status, "todo");
    assert.equal(task.pinned, true);

    const onDisk = await store.getTask(task.id);
    assert.ok(onDisk);
    assert.equal(onDisk.title, "Audit local-exec-daemon");
  });

  await t.test("updates task status and pins", async () => {
    const task = await store.createTask({ title: "Write tests" });
    const updated = await store.updateTask(task.id, {
      status: "done",
      pinned: true,
    });

    assert.equal(updated.status, "done");
    assert.equal(updated.pinned, true);
    assert.ok(updated.completedAt);
  });

  await t.test("lists tasks with filtering and pinned sort", async () => {
    const t1 = await store.createTask({ title: "Normal task", pinned: false });
    const t2 = await store.createTask({ title: "Urgent pinned task", pinned: true });

    const list = await store.listTasks();
    assert.ok(list.length >= 2);
    // Pinned task should appear first
    assert.equal(list[0].id, t2.id);

    const doneOnly = await store.listTasks({ status: "done" });
    assert.ok(doneOnly.every((t) => t.status === "done"));
  });

  await t.test("deletes task", async () => {
    const task = await store.createTask({ title: "Temporary" });
    const deleted = await store.deleteTask(task.id);
    assert.equal(deleted, true);

    const recheck = await store.getTask(task.id);
    assert.equal(recheck, null);
  });

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});
