import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  runStateMigrations,
  readSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  migrateV2,
  migrateSessionFolder,
} from "../src/state-migrations.js";
import { EventLogReader, EventLogWriter } from "../src/event-log.js";
import { EVENT } from "../src/event-log-types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opensand-migrations-"));
}

test("fresh state is stamped with CURRENT_SCHEMA_VERSION (2) and not backed up", () => {
  const dir = tempDir();
  const stateDir = path.join(dir, "state");

  assert.equal(CURRENT_SCHEMA_VERSION, 2);
  const result = runStateMigrations(stateDir);

  assert.equal(result.from, 0);
  assert.equal(result.to, 2);
  assert.equal(result.migrated, true);
  assert.equal(result.backupDir, null);
  assert.equal(readSchemaVersion(stateDir), 2);
});

test("existing state is backed up before a migration runs", () => {
  const dir = tempDir();
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "sessions.json"), "{\"a\":1}");
  fs.writeFileSync(path.join(stateDir, "schema.json"), "{\"version\":1}");

  const order: string[] = [];
  const result = runStateMigrations(stateDir, {
    currentVersion: 2,
    migrations: [
      {
        to: 2,
        up: (d) => {
          order.push("ran");
          fs.writeFileSync(path.join(d, "sessions.json"), "{\"a\":2}");
        },
      },
    ],
  });

  assert.deepEqual(order, ["ran"]);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.ok(result.backupDir);
  const backup = result.backupDir as string;
  assert.equal(fs.readFileSync(path.join(backup, "sessions.json"), "utf8"), "{\"a\":1}");
  assert.equal(fs.readFileSync(path.join(stateDir, "sessions.json"), "utf8"), "{\"a\":2}");
  assert.equal(readSchemaVersion(stateDir), 2);
});

test("an unstamped state directory with data is backed up before stamping", () => {
  const stateDir = path.join(tempDir(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "sessions.json"), "{\"a\":1}");

  const result = runStateMigrations(stateDir);

  assert.equal(result.from, 0);
  assert.equal(result.to, 2);
  assert.ok(result.backupDir);
  assert.equal(
    fs.readFileSync(path.join(result.backupDir as string, "sessions.json"), "utf8"),
    "{\"a\":1}",
  );
  assert.equal(readSchemaVersion(stateDir), 2);
});

test("a state directory already at the current version is left alone", () => {
  const stateDir = path.join(tempDir(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "schema.json"), "{\"version\":2}");

  const result = runStateMigrations(stateDir);

  assert.equal(result.migrated, false);
  assert.equal(result.backupDir, null);
  assert.equal(fs.existsSync(path.join(stateDir, "..", "state-backups")), false);
});

test("a newer state is refused instead of downgraded", () => {
  const stateDir = path.join(tempDir(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "schema.json"), "{\"version\":99}");

  assert.throws(() => runStateMigrations(stateDir), /newer than this build supports/);
});

test("a corrupt schema file fails with a readable message", () => {
  const stateDir = path.join(tempDir(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "schema.json"), "not json");

  assert.throws(() => runStateMigrations(stateDir), /Cannot read state schema/);
});

test("v2 migration: converts legacy v1 session to hash-chained event-log.jsonl and leaves legacy files untouched", async () => {
  const rootDir = tempDir();
  const stateDir = path.join(rootDir, "state");
  const sessionsDir = path.join(rootDir, "sessions");
  const sess1Dir = path.join(sessionsDir, "sess-legacy-1");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sess1Dir, { recursive: true });

  fs.writeFileSync(path.join(stateDir, "schema.json"), JSON.stringify({ version: 1 }));

  const metaData = {
    sessionId: "sess-legacy-1",
    model: "test-model-v1",
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  const messagesData = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello world" },
    { role: "assistant", content: "Hello! How can I help?" },
  ];

  fs.writeFileSync(path.join(sess1Dir, "meta.json"), JSON.stringify(metaData, null, 2));
  fs.writeFileSync(path.join(sess1Dir, "messages.json"), JSON.stringify(messagesData, null, 2));

  const result = runStateMigrations(stateDir);

  assert.equal(CURRENT_SCHEMA_VERSION, 2);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.equal(result.migrated, true);
  assert.ok(result.backupDir);
  assert.equal(readSchemaVersion(stateDir), 2);

  // Assert event-log.jsonl exists and verifyChain succeeds
  const logPath = path.join(sess1Dir, "event-log.jsonl");
  assert.ok(fs.existsSync(logPath), "event-log.jsonl must exist");

  const reader = new EventLogReader(sess1Dir);
  const verifyResult = await reader.verifyChain();
  assert.equal(verifyResult.valid, true);
  assert.equal(verifyResult.totalEvents, 2);

  const events = await reader.readAll();
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].kind, EVENT.sessionCreated);
  assert.equal(events[0].data.model, "test-model-v1");
  assert.equal(events[0].sessionId, "sess-legacy-1");

  assert.equal(events[1].seq, 2);
  assert.equal(events[1].kind, EVENT.snapshot);
  assert.deepEqual(events[1].data.messages, messagesData);

  // Assert legacy files are untouched
  assert.equal(fs.readFileSync(path.join(sess1Dir, "meta.json"), "utf8"), JSON.stringify(metaData, null, 2));
  assert.equal(fs.readFileSync(path.join(sess1Dir, "messages.json"), "utf8"), JSON.stringify(messagesData, null, 2));
});

test("v2 migration: idempotence - second migration run does not alter event-log.jsonl or duplicate events", async () => {
  const rootDir = tempDir();
  const stateDir = path.join(rootDir, "state");
  const sessionsDir = path.join(rootDir, "sessions");
  const sessDir = path.join(sessionsDir, "sess-idempotent");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "schema.json"), JSON.stringify({ version: 1 }));

  fs.writeFileSync(path.join(sessDir, "meta.json"), JSON.stringify({ sessionId: "sess-idempotent", model: "m" }));
  fs.writeFileSync(path.join(sessDir, "messages.json"), JSON.stringify([{ role: "user", content: "test" }]));

  // First run
  const res1 = runStateMigrations(stateDir);
  assert.equal(res1.migrated, true);

  const logPath = path.join(sessDir, "event-log.jsonl");
  const initialContent = fs.readFileSync(logPath, "utf8");

  // Append a 3rd event to simulate live turn progress
  const writer = new EventLogWriter(sessDir, { sessionId: "sess-idempotent" });
  await writer.append({ kind: EVENT.sessionRenamed, data: { title: "Renamed Title" } });

  const reader = new EventLogReader(sessDir);
  const eventsAfterAppend = await reader.readAll();
  assert.equal(eventsAfterAppend.length, 3);
  const contentWithAppend = fs.readFileSync(logPath, "utf8");

  // Second run via runStateMigrations (schema already at 2)
  const res2 = runStateMigrations(stateDir);
  assert.equal(res2.migrated, false);
  assert.equal(fs.readFileSync(logPath, "utf8"), contentWithAppend);

  // Direct migrateV2 run (simulating force re-running migration on same folders)
  const directReport = migrateV2(stateDir);
  const sessReport = directReport.sessions.find((s) => s.sessionId === "sess-idempotent");
  assert.equal(sessReport?.status, "skipped_existing");

  // Assert event-log.jsonl was untouched (still 3 events and verifying)
  assert.equal(fs.readFileSync(logPath, "utf8"), contentWithAppend);
  const verify = await reader.verifyChain();
  assert.equal(verify.valid, true);
  assert.equal(verify.totalEvents, 3);
});

test("v2 migration: broken or partial legacy sessions are skipped, recorded in report, and leave files untouched", async () => {
  const rootDir = tempDir();
  const stateDir = path.join(rootDir, "state");
  const sessionsDir = path.join(rootDir, "sessions");

  const sessValid = path.join(sessionsDir, "sess-valid");
  const sessBadMeta = path.join(sessionsDir, "sess-bad-meta");
  const sessCorruptMsg = path.join(sessionsDir, "sess-corrupt-msg");

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessValid, { recursive: true });
  fs.mkdirSync(sessBadMeta, { recursive: true });
  fs.mkdirSync(sessCorruptMsg, { recursive: true });

  fs.writeFileSync(path.join(stateDir, "schema.json"), JSON.stringify({ version: 1 }));

  // Valid session
  fs.writeFileSync(path.join(sessValid, "meta.json"), JSON.stringify({ sessionId: "sess-valid", model: "m" }));
  fs.writeFileSync(path.join(sessValid, "messages.json"), JSON.stringify([{ role: "user", content: "ok" }]));

  // Bad meta: missing meta.json
  const badMetaContent = JSON.stringify([{ role: "user", content: "bad meta" }]);
  fs.writeFileSync(path.join(sessBadMeta, "messages.json"), badMetaContent);

  // Corrupt messages: messages.json contains broken JSON
  const corruptMsgContent = "{ unparseable json";
  fs.writeFileSync(path.join(sessCorruptMsg, "meta.json"), JSON.stringify({ sessionId: "sess-corrupt-msg", model: "m" }));
  fs.writeFileSync(path.join(sessCorruptMsg, "messages.json"), corruptMsgContent);

  // Migration should succeed without throwing
  const result = runStateMigrations(stateDir);
  assert.equal(result.migrated, true);

  // Valid session migrated
  assert.ok(fs.existsSync(path.join(sessValid, "event-log.jsonl")));
  const validChain = await new EventLogReader(sessValid).verifyChain();
  assert.equal(validChain.valid, true);

  // Broken sessions skipped with no event-log.jsonl created
  assert.equal(fs.existsSync(path.join(sessBadMeta, "event-log.jsonl")), false);
  assert.equal(fs.readFileSync(path.join(sessBadMeta, "messages.json"), "utf8"), badMetaContent);

  assert.equal(fs.existsSync(path.join(sessCorruptMsg, "event-log.jsonl")), false);
  assert.equal(fs.readFileSync(path.join(sessCorruptMsg, "messages.json"), "utf8"), corruptMsgContent);

  // Report records skipped_broken
  const report = result.report;
  assert.ok(report);
  const badMetaReport = report.sessions.find((s) => s.sessionId === "sess-bad-meta");
  assert.equal(badMetaReport?.status, "skipped_broken");

  const corruptReport = report.sessions.find((s) => s.sessionId === "sess-corrupt-msg");
  assert.equal(corruptReport?.status, "skipped_broken");
});

test("v2 migration: crash safety with SIGKILL leaves either no log or a complete verifying log, and rerun finishes", async () => {
  const rootDir = tempDir();
  const stateDir = path.join(rootDir, "state");
  const sessionsDir = path.join(rootDir, "sessions");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "schema.json"), JSON.stringify({ version: 1 }));

  // Create 10 legacy sessions
  const numSessions = 10;
  for (let i = 1; i <= numSessions; i++) {
    const sDir = path.join(sessionsDir, `sess-${i}`);
    fs.mkdirSync(sDir, { recursive: true });
    fs.writeFileSync(path.join(sDir, "meta.json"), JSON.stringify({ sessionId: `sess-${i}`, model: "m" }));
    fs.writeFileSync(path.join(sDir, "messages.json"), JSON.stringify([
      { role: "system", content: "sys prompt" },
      { role: "user", content: `query ${i}` },
      { role: "assistant", content: `response ${i}` }
    ]));
  }

  const moduleUrl = new URL("../src/state-migrations.js", import.meta.url).href;
  const childScript = `
    import { runStateMigrations } from ${JSON.stringify(moduleUrl)};
    process.stdout.write("STARTING\\n");
    runStateMigrations(process.env.STATE_DIR);
    process.stdout.write("FINISHED\\n");
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (chunk.includes("STARTING")) {
      started = true;
    }
  });

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  // Wait a small delay to simulate mid-migration, then SIGKILL
  await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 10)));
  child.kill("SIGKILL");
  await closed;

  // Verify post-kill state: any session with event-log.jsonl MUST verify completely
  for (let i = 1; i <= numSessions; i++) {
    const sDir = path.join(sessionsDir, `sess-${i}`);
    const logPath = path.join(sDir, "event-log.jsonl");
    if (fs.existsSync(logPath)) {
      const verification = await new EventLogReader(sDir).verifyChain();
      assert.equal(verification.valid, true, `session ${i} has invalid event log after SIGKILL`);
      assert.equal(verification.totalEvents, 2);
    }
  }

  // Rerun migration - must complete cleanly and migrate all sessions
  const rerunResult = runStateMigrations(stateDir);
  assert.equal(readSchemaVersion(stateDir), 2);

  for (let i = 1; i <= numSessions; i++) {
    const sDir = path.join(sessionsDir, `sess-${i}`);
    const logPath = path.join(sDir, "event-log.jsonl");
    assert.ok(fs.existsSync(logPath), `session ${i} must have event-log.jsonl after rerun`);
    const verification = await new EventLogReader(sDir).verifyChain();
    assert.equal(verification.valid, true, `session ${i} failed verifyChain after rerun`);
    assert.equal(verification.totalEvents, 2);
  }
});
