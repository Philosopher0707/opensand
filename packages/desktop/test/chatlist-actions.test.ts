import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
// Overridable so a mutation check can point at patched copies of the two sources.
const CHATLIST_FILE = process.env.CHATLIST_SOURCE
  ? path.resolve(process.env.CHATLIST_SOURCE)
  : path.join(pkgRoot, "renderer-next/src/views/ChatList.tsx");
const DATA_FILE = process.env.CHATLIST_DATA_SOURCE
  ? path.resolve(process.env.CHATLIST_DATA_SOURCE)
  : path.join(pkgRoot, "renderer-next/src/data.ts");

const chatList = fs.readFileSync(CHATLIST_FILE, "utf8");
const dataLayer = fs.readFileSync(DATA_FILE, "utf8");

test("chatlist-actions: delete uses inline confirmation and no blocking dialogs", () => {
  assert.doesNotMatch(chatList, /window\s*\.\s*confirm\s*\(/, "window.confirm must be gone");
  assert.doesNotMatch(chatList, /\balert\s*\(/, "alert must be gone");
  assert.match(chatList, /Confirm delete/);
  assert.match(chatList, /Cancel/);
  assert.match(chatList, /confirmingDeleteId/);
  assert.match(chatList, /handleConfirmDelete/);
  assert.match(chatList, /onClick=\{\(e\) => handleConfirmDelete\(e, row\)\}/, "confirm button must call the delete handler");
});

test("chatlist-actions: rename is wired through validation, the data layer and a plain error", () => {
  assert.match(chatList, /data\.renameSession\(/);
  assert.match(chatList, /validateSessionTitle\(/);
  assert.match(chatList, /formatSessionError\(/);
  assert.match(chatList, /role="alert"/);
  assert.match(chatList, /aria-label=\{`Rename conversation/);
});

test("chatlist-actions: list refreshes on the session-change event", () => {
  assert.match(chatList, /SESSIONS_CHANGED_EVENT/);
  assert.match(chatList, /window\.addEventListener\(SESSIONS_CHANGED_EVENT/);
  assert.match(chatList, /void reload\(\)/);
});

test("chatlist-actions: data layer exposes rename and notifies on session activity", () => {
  assert.match(dataLayer, /renameSession\(id: string, title: string\): Promise<boolean>/);
  assert.match(dataLayer, /sessionRenameRequest\(id, title\)/);
  assert.match(dataLayer, /if \(result\?\.success\) notifySessionsChanged\(\)/);
  assert.match(dataLayer, /event\?\.type === "turn_complete"\) notifySessionsChanged\(\)/);
});
