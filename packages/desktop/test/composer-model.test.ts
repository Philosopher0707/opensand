import test from "node:test";
import assert from "node:assert";
import {
  formatBytes,
  formatDoctorReport,
  friendlyErrorMessage,
  getFileCategory,
  composePromptWithAttachments,
  applyPromptChip,
  detectTrigger,
  filterSlashCommands,
  insertTriggerSelection,
  parseSlashCommand,
  runLocalSlashCommand,
  DEFAULT_PROMPT_CHIPS,
  DEFAULT_SLASH_COMMANDS,
  type LocalSlashContext,
  type StagedAttachment,
  type SlashCommand,
} from "../src/shell/composer-model.js";

function slashContext(overrides: Partial<LocalSlashContext> = {}) {
  const notices: string[] = [];
  const ctx: LocalSlashContext = {
    hasSession: true,
    notice: (message) => notices.push(message),
    ...overrides,
  };
  return { ctx, notices };
}

test("ComposerModel - formatBytes", () => {
  assert.strictEqual(formatBytes(0), "0 B");
  assert.strictEqual(formatBytes(-10), "0 B");
  assert.strictEqual(formatBytes(undefined), "0 B");
  assert.strictEqual(formatBytes(512), "512 B");
  assert.strictEqual(formatBytes(1024), "1 KB");
  assert.strictEqual(formatBytes(1536), "1.5 KB");
  assert.strictEqual(formatBytes(1048576), "1 MB");
  assert.strictEqual(formatBytes(2621440), "2.5 MB");
  assert.strictEqual(formatBytes(1073741824), "1 GB");
});

test("ComposerModel - getFileCategory", () => {
  assert.strictEqual(getFileCategory("photo.png", "image/png"), "image");
  assert.strictEqual(getFileCategory("screenshot.JPG"), "image");
  assert.strictEqual(getFileCategory("icon.svg"), "image");
  assert.strictEqual(getFileCategory("index.ts"), "code");
  assert.strictEqual(getFileCategory("app.js"), "code");
  assert.strictEqual(getFileCategory("main.py"), "code");
  assert.strictEqual(getFileCategory("data.json", "application/json"), "code");
  assert.strictEqual(getFileCategory("notes.md"), "code");
  assert.strictEqual(getFileCategory("binary.dat"), "file");
  assert.strictEqual(getFileCategory("archive.zip", "application/zip"), "file");
});

test("ComposerModel - composePromptWithAttachments", () => {
  const attachments: StagedAttachment[] = [
    { name: "test.ts", size: 1024, type: "text/typescript", localPath: "/src/test.ts" },
    { name: "diag.png", size: 2048, type: "image/png" },
  ];

  // Empty attachments
  assert.strictEqual(composePromptWithAttachments("Hello world", []), "Hello world");
  assert.strictEqual(composePromptWithAttachments("  ", []), "");

  // With query and attachments
  const composed = composePromptWithAttachments("Please review this code", attachments);
  assert.ok(composed.startsWith("Please review this code\n\n[Attachment: test.ts (1 KB) - /src/test.ts]"));
  assert.ok(composed.includes("[Attachment: diag.png (2 KB) - diag.png]"));

  // Empty query with attachments
  const emptyQueryComposed = composePromptWithAttachments("", attachments);
  assert.ok(emptyQueryComposed.startsWith("Please inspect and process the attached context files:\n"));
  assert.ok(emptyQueryComposed.includes("[Attachment: test.ts (1 KB) - /src/test.ts]"));
});

test("ComposerModel - applyPromptChip", () => {
  assert.strictEqual(applyPromptChip("", "Inspect repo"), "Inspect repo");
  assert.strictEqual(applyPromptChip("   ", "Inspect repo"), "Inspect repo");
  assert.strictEqual(applyPromptChip("Hello", "Inspect repo"), "Hello Inspect repo");
  assert.strictEqual(applyPromptChip("Hello ", "Inspect repo"), "Hello Inspect repo");
});

test("ComposerModel - detectTrigger", () => {
  // Start of string
  const m1 = detectTrigger("/c", 2);
  assert.deepStrictEqual(m1, { triggerChar: "/", query: "c", startPos: 0 });

  const m2 = detectTrigger("/compact", 8);
  assert.deepStrictEqual(m2, { triggerChar: "/", query: "compact", startPos: 0 });

  // With preceding text and space
  const text3 = "please check /doc";
  const m3 = detectTrigger(text3, text3.length);
  assert.deepStrictEqual(m3, { triggerChar: "/", query: "doc", startPos: 13 });

  // @ mention trigger
  const text4 = "ask @pix";
  const m4 = detectTrigger(text4, text4.length);
  assert.deepStrictEqual(m4, { triggerChar: "@", query: "pix", startPos: 4 });

  // # file trigger
  const text5 = "include #READ";
  const m5 = detectTrigger(text5, text5.length);
  assert.deepStrictEqual(m5, { triggerChar: "#", query: "read", startPos: 8 });

  // Not a trigger: mid-word slash or char without space
  assert.strictEqual(detectTrigger("http://foo", 8), null);
  assert.strictEqual(detectTrigger("foo/bar", 7), null);

  // Caret in between
  const text6 = "/comp something else";
  const m6 = detectTrigger(text6, 5);
  assert.deepStrictEqual(m6, { triggerChar: "/", query: "comp", startPos: 0 });

  // Out of bounds
  assert.strictEqual(detectTrigger("/test", -1), null);
  assert.strictEqual(detectTrigger("/test", 100), null);
});

test("ComposerModel - filterSlashCommands", () => {
  const commands: SlashCommand[] = [
    { icon: "🏗️", title: "/audit", desc: "Conduct architectural & code health audit", tag: "Command" },
    { icon: "🧹", title: "/compact", desc: "Auto-compact conversation history", tag: "Command" },
    { icon: "⏪", title: "/rollback", desc: "Rollback previous conversation turn", tag: "Command" },
  ];

  assert.strictEqual(filterSlashCommands(commands, "").length, 3);
  assert.strictEqual(filterSlashCommands(commands, "comp").length, 1);
  assert.strictEqual(filterSlashCommands(commands, "comp")[0].title, "/compact");
  assert.strictEqual(filterSlashCommands(commands, "ROLL").length, 1);
  assert.strictEqual(filterSlashCommands(commands, "health").length, 1);
  assert.strictEqual(filterSlashCommands(commands, "health")[0].title, "/audit");
  assert.strictEqual(filterSlashCommands(commands, "nonexistent").length, 0);
});

test("ComposerModel - insertTriggerSelection", () => {
  // Replace at start
  const res1 = insertTriggerSelection("/co", 0, 3, "/compact");
  assert.strictEqual(res1.newText, "/compact ");
  assert.strictEqual(res1.newCaretPos, 9);

  // Replace inside sentence
  const res2 = insertTriggerSelection("Hello /doc more text", 6, 10, "/doctor");
  assert.strictEqual(res2.newText, "Hello /doctor more text");
  assert.strictEqual(res2.newCaretPos, 14);
});

test("ComposerModel - default constants validity", () => {
  assert.ok(DEFAULT_PROMPT_CHIPS.length >= 4);
  assert.ok(DEFAULT_PROMPT_CHIPS[0].query);
  assert.ok(DEFAULT_SLASH_COMMANDS.length >= 7);
  assert.ok(DEFAULT_SLASH_COMMANDS.some((c) => c.title === "/compact"));
  assert.ok(DEFAULT_SLASH_COMMANDS.some((c) => c.title === "/rollback"));
  assert.ok(DEFAULT_SLASH_COMMANDS.some((c) => c.title === "/clear"));
  assert.ok(DEFAULT_SLASH_COMMANDS.some((c) => c.title === "/help"));
});

test("ComposerModel - parseSlashCommand handles only local commands", () => {
  assert.deepStrictEqual(parseSlashCommand("/compact"), { action: "compact" });
  assert.deepStrictEqual(parseSlashCommand("  /ROLLBACK  "), { action: "rollback" });
  assert.deepStrictEqual(parseSlashCommand("/rewind"), { action: "rollback" });
  assert.deepStrictEqual(parseSlashCommand("/clear"), { action: "clear" });
  assert.deepStrictEqual(parseSlashCommand("/doctor"), { action: "doctor" });
  assert.strictEqual(parseSlashCommand("/help"), null);
  assert.strictEqual(parseSlashCommand("please /compact the history"), null);
  assert.strictEqual(parseSlashCommand(""), null);
});

test("ComposerModel - friendlyErrorMessage never forwards raw error text", () => {
  assert.strictEqual(
    friendlyErrorMessage(new Error("ENOENT: /secret/path.txt"), "Could not attach the file."),
    "Could not attach the file. The file could not be found.",
  );
  assert.strictEqual(
    friendlyErrorMessage(new Error("fetch failed at http://localhost:1234/api"), "Could not load history."),
    "Could not load history. Check your connection and try again.",
  );
  assert.strictEqual(
    friendlyErrorMessage(new Error("Error: bad token eyJhbGciOiJIUzI1NiJ9"), "Could not load history."),
    "Could not load history.",
  );
});

test("ComposerModel - formatDoctorReport keeps a short read-only summary", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const report = formatDoctorReport({ text, data: { apiKey: "stored" } });
  assert.ok(report.startsWith("line 0"));
  assert.ok(report.split("\n").length <= 8);
  assert.ok(!report.includes("line 8"));
  assert.ok(!report.includes("apiKey"));
  assert.match(formatDoctorReport({}), /No details were reported/);
});

test("ComposerModel - runLocalSlashCommand passes normal text through", async () => {
  let called = 0;
  const { ctx, notices } = slashContext({
    compact: async () => { called++; return {}; },
  });
  assert.strictEqual(runLocalSlashCommand("explain this repo", ctx), false);
  assert.strictEqual(called, 0);
  assert.strictEqual(notices.length, 0);
});

test("ComposerModel - compact and rollback run locally", async () => {
  let compacted = 0;
  let rolled = 0;
  const { ctx, notices } = slashContext({
    compact: async () => { compacted++; return { compactedTurnCount: 3, originalTokens: 900, compactedTokens: 200 }; },
    rollback: async () => { rolled++; return { removedMessages: 2, remainingMessages: 5 }; },
  });
  assert.strictEqual(await runLocalSlashCommand("/compact", ctx), true);
  assert.strictEqual(compacted, 1);
  assert.match(notices[0], /3 turns, 900 to 200 tokens/);
  assert.strictEqual(await runLocalSlashCommand("/rewind", ctx), true);
  assert.strictEqual(rolled, 1);
  assert.match(notices[1], /2 messages/);
});

test("ComposerModel - clear resets the view without a session", async () => {
  let cleared = 0;
  const { ctx, notices } = slashContext({
    hasSession: false,
    clearView: () => { cleared++; },
    compact: async () => { throw new Error("must not be called"); },
  });
  assert.strictEqual(await runLocalSlashCommand("/clear", ctx), true);
  assert.strictEqual(cleared, 1);
  assert.match(notices[0], /Conversation cleared/);
});

test("ComposerModel - compact without a session shows a plain notice", async () => {
  let compacted = 0;
  const { ctx, notices } = slashContext({
    hasSession: false,
    compact: async () => { compacted++; return {}; },
  });
  assert.strictEqual(await runLocalSlashCommand("/compact", ctx), true);
  assert.strictEqual(compacted, 0);
  assert.strictEqual(notices[0], "Select a conversation first.");
});

test("ComposerModel - doctor shows report text, never fetches the LLM", async () => {
  let fetches = 0;
  const { ctx, notices } = slashContext({
    fetchReport: async () => {
      fetches++;
      return { ok: true, json: async () => ({ text: "OpenSand diagnostics\napp: 0.1.14", data: {} }) };
    },
  });
  assert.strictEqual(await runLocalSlashCommand("/doctor", ctx), true);
  assert.strictEqual(fetches, 1);
  assert.match(notices[0], /OpenSand diagnostics/);
  assert.match(notices[0], /app: 0\.1\.14/);
});

test("ComposerModel - doctor and compact failures stay user-facing", async () => {
  const failed = slashContext({ fetchReport: async () => ({ ok: false, json: async () => ({}) }) });
  assert.strictEqual(await runLocalSlashCommand("/doctor", failed.ctx), true);
  assert.strictEqual(failed.notices[0], "Doctor check is unavailable right now.");

  const thrown = slashContext({
    compact: async () => { throw new Error("429 raw provider stack at http://localhost:1234"); },
  });
  assert.strictEqual(await runLocalSlashCommand("/compact", thrown.ctx), true);
  assert.strictEqual(thrown.notices[0], "The compact command could not be completed. Try again.");
});
