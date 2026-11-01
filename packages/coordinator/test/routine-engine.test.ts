import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  RoutineEngine,
  matchesCron,
  computeNextRunAtMs,
  matchesCronField,
  AgentRoutine,
} from "../src/routine-engine.js";
import { VaultStore } from "../src/vault-store.js";

describe("RoutineEngine", () => {
  let tempDir: string;
  let vaultDir: string;
  let routineEngine: RoutineEngine;
  let vaultStore: VaultStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-routines-test-"));
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-vault-test-"));
    vaultStore = new VaultStore({ baseDir: vaultDir });
    routineEngine = new RoutineEngine(tempDir, vaultStore);
  });

  afterEach(async () => {
    routineEngine.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  describe("Cron Parsing & Matching", () => {
    it("correctly matches wildcard and exact fields", () => {
      const d = new Date(2026, 9, 31, 14, 30); // 2026-10-31 14:30 (Saturday)
      assert.strictEqual(matchesCron("* * * * *", d), true);
      assert.strictEqual(matchesCron("30 14 31 10 6", d), true);
      assert.strictEqual(matchesCron("31 14 * * *", d), false);
      assert.strictEqual(matchesCron("* 15 * * *", d), false);
    });

    it("correctly matches steps, ranges, and lists", () => {
      const d = new Date(2026, 9, 31, 14, 30);
      assert.strictEqual(matchesCron("*/15 * * * *", d), true);
      assert.strictEqual(matchesCron("*/20 * * * *", d), false);
      assert.strictEqual(matchesCron("10,20,30 * * * *", d), true);
      assert.strictEqual(matchesCron("* 10-16 * * *", d), true);
      assert.strictEqual(matchesCron("* 0-12 * * *", d), false);
    });

    it("computes next run timestamp for intervals and cron", () => {
      const base = new Date(1700000000000);
      const nextInterval = computeNextRunAtMs({ type: "interval", intervalMinutes: 15 }, base);
      assert.strictEqual(nextInterval, 1700000000000 + 15 * 60 * 1000);

      const nextCron = computeNextRunAtMs({ type: "cron", cron: "*/5 * * * *" }, base);
      assert.ok(nextCron > base.getTime());
      const nextDate = new Date(nextCron);
      assert.strictEqual(nextDate.getMinutes() % 5, 0);
      assert.strictEqual(nextDate.getSeconds(), 0);
    });
  });

  describe("Routine CRUD & Lifecycle", () => {
    it("creates, stores, lists, and retrieves routines", async () => {
      const routine = await routineEngine.createRoutine({
        name: "Sync Database Backup",
        prompt: "Run db sync command and verify backup status",
        scheduleType: "interval",
        intervalMinutes: 30,
        allowedTools: ["exec_command"],
      });

      assert.ok(routine.routineId.startsWith("routine_"));
      assert.strictEqual(routine.name, "Sync Database Backup");
      assert.strictEqual(routine.isEnabled, true);
      assert.ok(routine.nextRunAtMs! > Date.now());

      const retrieved = await routineEngine.getRoutine(routine.routineId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved?.name, "Sync Database Backup");

      const all = await routineEngine.listRoutines();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].routineId, routine.routineId);
    });

    it("enables and disables routines accurately", async () => {
      const routine = await routineEngine.createRoutine({
        name: "Nightly Audit",
        prompt: "Check audit logs",
        scheduleType: "cron",
        cron: "0 0 * * *",
      });

      assert.strictEqual(routine.isEnabled, true);
      assert.ok(routine.nextRunAtMs);

      const disabled = await routineEngine.setRoutineEnabled(routine.routineId, false);
      assert.strictEqual(disabled.isEnabled, false);
      assert.strictEqual(disabled.nextRunAtMs, undefined);

      const reEnabled = await routineEngine.setRoutineEnabled(routine.routineId, true);
      assert.strictEqual(reEnabled.isEnabled, true);
      assert.ok(reEnabled.nextRunAtMs! > Date.now());
    });

    it("triggers routine execution, auto-redacts secrets, and logs execution", async () => {
      // Store secret in vault to verify auto-redaction during routine run
      await vaultStore.putSecret({
        name: "PROD_DATABASE_KEY",
        value: "super_secret_db_password_123",
      });

      routineEngine.setExecutor(async (_r: AgentRoutine) => {
        return {
          status: "success",
          result: `Connected with key: super_secret_db_password_123 and executed successfully.`,
        };
      });

      const routine = await routineEngine.createRoutine({
        name: "Security Probe",
        prompt: "Inspect production DB",
        scheduleType: "interval",
        intervalMinutes: 10,
      });

      const { routine: ranRoutine, result, status } = await routineEngine.triggerRoutine(routine.routineId);

      assert.strictEqual(status, "success");
      assert.strictEqual(ranRoutine.runCount, 1);
      assert.strictEqual(ranRoutine.lastRunStatus, "success");
      // Verify redaction:
      assert.ok(result.includes("[REDACTED_VAULT_SECRET:PROD_DATABASE_KEY]"));
      assert.ok(!result.includes("super_secret_db_password_123"));

      const logs = await routineEngine.getRoutineLogs(routine.routineId);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0].status, "success");
      assert.ok(logs[0].result.includes("[REDACTED_VAULT_SECRET:PROD_DATABASE_KEY]"));
    });

    it("evaluates due routines on background tick", async () => {
      let executedCount = 0;
      routineEngine.setExecutor(async () => {
        executedCount++;
        return { status: "success", result: "ok" };
      });

      const routine = await routineEngine.createRoutine({
        name: "Immediate Routine",
        prompt: "Run fast",
        scheduleType: "interval",
        intervalMinutes: 1,
      });

      // Manually backdate nextRunAtMs so it is due
      routine.nextRunAtMs = Date.now() - 5000;
      await (routineEngine as any).saveRoutine(routine);

      await routineEngine.tick();
      assert.strictEqual(executedCount, 1);

      const updated = await routineEngine.getRoutine(routine.routineId);
      assert.strictEqual(updated?.runCount, 1);
      assert.ok(updated?.nextRunAtMs! > Date.now());
    });

    it("deletes routine and cleans up logs", async () => {
      const routine = await routineEngine.createRoutine({
        name: "Temporary Routine",
        prompt: "Run once",
        scheduleType: "interval",
        intervalMinutes: 60,
      });

      await routineEngine.triggerRoutine(routine.routineId);
      const logsBefore = await routineEngine.getRoutineLogs(routine.routineId);
      assert.strictEqual(logsBefore.length, 1);

      const deleted = await routineEngine.deleteRoutine(routine.routineId);
      assert.strictEqual(deleted, true);

      const found = await routineEngine.getRoutine(routine.routineId);
      assert.strictEqual(found, null);

      const logsAfter = await routineEngine.getRoutineLogs(routine.routineId);
      assert.strictEqual(logsAfter.length, 0);
    });
  });
});
