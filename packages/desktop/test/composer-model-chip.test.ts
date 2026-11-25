import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(__dirname, "../../renderer/modules/chat/model-chip.js");
const appPath = path.join(__dirname, "../../renderer/app.js");

type El = { textContent: string; title: string };
const el = (): El => ({ textContent: "Model", title: "" });

async function load() {
  assert.ok(fs.existsSync(modulePath), `model chip module missing at ${modulePath}`);
  return import(pathToFileURL(modulePath).href);
}

test("composer chip text equals the top-bar text after a settings change", async () => {
  const { applyActiveModel } = await load();
  const top = el();
  const chip = el();
  applyActiveModel({ topBar: top, chip }, "nvidia/nemotron-3.5-lightning", "Context 128k");
  assert.strictEqual(chip.textContent, top.textContent);
  applyActiveModel({ topBar: top, chip }, "nemotron-3.5-lightning:free");
  assert.strictEqual(top.textContent, "nemotron-3.5-lightning:free");
  assert.strictEqual(chip.textContent, top.textContent, "chip must follow the top bar");
});

test("a turn that reports a different model moves the chip text, not only its title", async () => {
  const { applyActiveModel } = await load();
  const top = el();
  const chip = el();
  applyActiveModel({ topBar: top, chip }, "nvidia/nemotron-3.5-lightning");
  applyActiveModel({ topBar: top, chip }, "openrouter/nemotron-3.5-lightning:free");
  assert.strictEqual(chip.textContent, "nemotron-3.5-lightning:free");
  assert.strictEqual(chip.textContent, top.textContent);
  assert.match(chip.title, /openrouter\/nemotron-3\.5-lightning:free/, "full id stays in the tooltip");
});

test("placeholder names never overwrite a real model", async () => {
  const { applyActiveModel } = await load();
  const top = el();
  const chip = el();
  applyActiveModel({ topBar: top, chip }, "gpt-x");
  applyActiveModel({ topBar: top, chip }, "Model");
  assert.strictEqual(chip.textContent, "gpt-x");
  assert.strictEqual(top.textContent, "gpt-x");
});

test("a bot with its own model wins over the global model; no bot model falls back", async () => {
  const { effectiveModel } = await load();
  assert.strictEqual(effectiveModel({ botModel: "bot/own-model", settingsModel: "global/model" }), "bot/own-model");
  assert.strictEqual(effectiveModel({ botModel: "", settingsModel: "global/model" }), "global/model");
  assert.strictEqual(effectiveModel({ botModel: "  ", settingsModel: "" }), "Default");
});

test("legacy app.js routes every model update through the shared helper", () => {
  const app = fs.readFileSync(appPath, "utf8");
  assert.ok(app.includes("from './modules/chat/model-chip.js'"), "helper imported");
  assert.ok(!/composerModelBadge\.textContent\s*=/.test(app), "no direct chip text writes remain");
  assert.ok(!/badgeModel\.textContent\s*=/.test(app), "no direct top-bar text writes remain");
  assert.ok(app.includes("effectiveModel({"), "bot model considered");
  const save = app.slice(app.indexOf("btnSaveSettings.onclick"));
  assert.ok(save.slice(0, 900).includes("await refreshSettings();"), "saving settings refreshes the chip");
});
