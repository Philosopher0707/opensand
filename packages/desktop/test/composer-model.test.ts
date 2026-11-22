import test from "node:test";
import assert from "node:assert";
import {
  formatBytes,
  getFileCategory,
  composePromptWithAttachments,
  applyPromptChip,
  detectTrigger,
  filterSlashCommands,
  insertTriggerSelection,
  DEFAULT_PROMPT_CHIPS,
  DEFAULT_SLASH_COMMANDS,
  type StagedAttachment,
  type SlashCommand,
} from "../src/shell/composer-model.js";

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
