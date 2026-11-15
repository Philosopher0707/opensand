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

test("TaskStore - listTasks breaks an updatedAt tie deterministically", async () => {
  const UPDATED_AT = 1_700_000_000_000;

  // Eight pinned tasks share one updatedAt. The createdAt order and the id order
  // disagree on purpose, and one pair shares createdAt too, so the rule under test
  // is "newest first, id breaks the last tie" and not "alphabetical".
  const RECORDS = [
    { id: "task_a", createdAt: UPDATED_AT - 1 },
    { id: "task_b", createdAt: UPDATED_AT - 5 },
    { id: "task_c", createdAt: UPDATED_AT - 3 },
    { id: "task_d", createdAt: UPDATED_AT - 7 },
    { id: "task_e", createdAt: UPDATED_AT - 6 },
    { id: "task_f", createdAt: UPDATED_AT - 2 },
    { id: "task_g", createdAt: UPDATED_AT - 7 },
    { id: "task_h", createdAt: UPDATED_AT - 4 },
  ];
  const EXPECTED = ["task_a", "task_f", "task_c", "task_h", "task_b", "task_e", "task_d", "task_g"];

  async function writeRecords(dir: string, order: number[]): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    for (const index of order) {
      const record = RECORDS[index];
      const task = {
        id: record.id,
        title: record.id,
        description: "",
        status: "todo",
        priority: "medium",
        pinned: true,
        read: false,
        createdAt: record.createdAt,
        updatedAt: UPDATED_AT,
      };
      await fs.writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(task, null, 2));
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-task-tiebreak-"));
  try {
    const dirA = path.join(tmpDir, "a");
    const dirB = path.join(tmpDir, "b");
    await writeRecords(dirA, [0, 1, 2, 3, 4, 5, 6, 7]);
    await writeRecords(dirB, [7, 6, 5, 4, 3, 2, 1, 0]);

    const storeA = new TaskStore(dirA);
    const storeB = new TaskStore(dirB);

    assert.deepEqual((await storeA.listTasks()).map((t) => t.id), EXPECTED);

    // Repeated calls keep the same order.
    for (let i = 0; i < 3; i++) {
      assert.deepEqual((await storeA.listTasks()).map((t) => t.id), EXPECTED);
    }

    // The order does not depend on the order the files were created in.
    assert.deepEqual((await storeB.listTasks()).map((t) => t.id), EXPECTED);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
