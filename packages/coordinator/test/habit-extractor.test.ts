import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { HabitExtractor } from "../src/habit-extractor.js";

test("HabitExtractor - Continuous User Learning Parity", async (t) => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-habit-test-"));
  const sessionsDir = path.join(tmpBase, "sessions");
  const memoryFile = path.join(tmpBase, "learned_rules.md");

  // Create mock sessions matching Grok Bot transcript wire format
  const session1 = path.join(sessionsDir, "sess_1");
  const session2 = path.join(sessionsDir, "sess_2");
  await fs.mkdir(session1, { recursive: true });
  await fs.mkdir(session2, { recursive: true });

  const transcript1 = `
user:
<user_query>
Please run the tests using pnpm test and verify code health.
</user_query>

assistant:
Running tests now.
[Tool call: exec_command]
CommandLine: pnpm test
[Tool result: exec_command]
59 passed
`;

  const transcript2 = `
user:
<user_query>
Hey this job is for the agent orchestrator to make bots not yours, so do a parity check.
</user_query>

assistant:
Understood, delegating to Agent Orchestrator.
`;

  await fs.writeFile(path.join(session1, "transcript.txt"), transcript1, "utf-8");
  await fs.writeFile(path.join(session2, "transcript.txt"), transcript2, "utf-8");

  const extractor = new HabitExtractor({
    sessionsDir,
    memoryFilePath: memoryFile,
  });

  await t.test("analyzes transcripts and detects queries & corrections", async () => {
    const report = await extractor.analyzeTranscripts();

    assert.equal(report.totalTranscriptsAnalyzed, 2);
    assert.equal(report.extractedQueriesCount, 2);
    assert.equal(report.correctionsCount, 1); // session 2 is a correction
    assert.ok(report.rules.length > 0);

    // Verify rules file was written to disk
    const onDisk = await fs.readFile(memoryFile, "utf-8");
    assert.ok(onDisk.includes("# OpenSand Continuous Learning & User Guidelines"));
    assert.ok(onDisk.includes("pnpm"));
    assert.ok(onDisk.includes("Agent Orchestrator"));
  });

  // Cleanup
  await fs.rm(tmpBase, { recursive: true, force: true });
});
