import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { versionLabel } from "../src/shell/version-model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyModule = path.join(__dirname, "../../renderer/modules/version-label.js");
const legacyApp = path.join(__dirname, "../../renderer/app.js");
const legacyHtml = path.join(__dirname, "../../renderer/index.html");
const nextView = path.join(__dirname, "../../renderer-next/src/views/SettingsView.tsx");
const nextData = path.join(__dirname, "../../renderer-next/src/data.ts");

test("version label shows the installed version and falls back to a plain message", () => {
  assert.strictEqual(versionLabel({ app: "0.1.16" }), "OpenSand v0.1.16");
  assert.strictEqual(versionLabel({ app: { version: "0.1.16" } }), "OpenSand v0.1.16");
  assert.strictEqual(versionLabel({ app: "  0.1.16  " }), "OpenSand v0.1.16");
  assert.strictEqual(versionLabel({ app: "" }), "Version unavailable");
  assert.strictEqual(versionLabel({ app: 42 }), "Version unavailable");
  assert.strictEqual(versionLabel(null), "Version unavailable");
  assert.strictEqual(versionLabel(undefined), "Version unavailable");
});

test("legacy renderer module formats the same label from the shipped source", async () => {
  const mod = await import(pathToFileURL(legacyModule).href);
  assert.strictEqual(mod.versionLabel({ app: "0.1.16" }), "OpenSand v0.1.16");
  assert.strictEqual(mod.versionLabel({ app: { version: "0.1.16" } }), "OpenSand v0.1.16");
  assert.strictEqual(mod.versionLabel(undefined), "Version unavailable");
});

test("both Settings screens mount a version footer with a loading and error state", () => {
  const html = fs.readFileSync(legacyHtml, "utf8");
  assert.ok(html.includes('id="settingsVersion"'), "legacy modal has a version footer");
  assert.ok(/id="settingsVersion"[^>]*>\s*…/.test(html), "legacy footer starts in the loading state");

  const app = fs.readFileSync(legacyApp, "utf8");
  assert.ok(app.includes("import { versionLabel } from './modules/version-label.js';"), "legacy formatter imported");
  assert.ok(app.includes("fetch('/api/version')"), "legacy footer reads the version route");
  assert.ok(app.includes("settingsVersion.textContent = versionLabel(await res.json());"), "legacy success text");
  assert.ok(/catch \{\s*settingsVersion\.textContent = 'Version unavailable';/m.test(app), "legacy error fallback");

  const view = fs.readFileSync(nextView, "utf8");
  assert.ok(view.includes('id="settingsVersion"'), "Preact Settings has a version footer");
  assert.ok(view.includes("useState(\"…\")"), "Preact footer starts in the loading state");
  assert.ok(view.includes("setVersion(versionLabel(report))"), "Preact success text");
  assert.ok(view.includes("setVersion(\"Version unavailable\")"), "Preact error fallback");
  assert.ok(view.includes("data.getVersion()"), "Preact footer fetches through the data layer");

  const data = fs.readFileSync(nextData, "utf8");
  assert.ok(data.includes('fetch)("/api/version")'), "data layer reads the version route");
});
