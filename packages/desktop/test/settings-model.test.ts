import test from "node:test";
import assert from "node:assert";
import {
  savePayload,
  loadEngineStatus,
  ENGINE_STATUS_UNAVAILABLE,
  toEngineStatus,
  ENGINE_OPTIONS,
  MASKED_KEY,
  connectionError,
  enginePayload,
  isExternalEngine,
  maskedKey,
  resolveEngineChoice,
  saveErrorMessage,
  settingsPayload,
  validateSettingsForm,
  welcomeState,
  type EngineId,
  type SettingsForm,
} from "../src/shell/settings-model.js";

const form = (overrides: Partial<SettingsForm> = {}): SettingsForm => ({
  provider: "openai",
  endpoint: " https://api.example.com/v1/chat/completions ",
  model: " test-model ",
  apiKey: "sk-new-123",
  ...overrides,
});

test("settings-model: a saved key is masked and never returned in full", () => {
  assert.strictEqual(maskedKey("sk-super-secret"), MASKED_KEY);
  assert.strictEqual(maskedKey("none"), "");
  assert.strictEqual(maskedKey(undefined), "");
  assert.ok(!maskedKey("sk-super-secret").includes("sk-super-secret"));
});

test("settings-model: save succeeds with a new key and trims the endpoint and model", () => {
  assert.strictEqual(validateSettingsForm(form(), false), null);
  assert.deepStrictEqual(settingsPayload(form()), {
    provider: "openai",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "sk-new-123",
  });
});

test("settings-model: save with an untouched masked key keeps the stored secret", () => {
  const untouched = form({ apiKey: MASKED_KEY });
  assert.strictEqual(validateSettingsForm(untouched, true), null);
  assert.deepStrictEqual(settingsPayload(untouched), {
    provider: "openai",
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "test-model",
  });
});

test("settings-model: save fails with a plain error on missing endpoint, model or key", () => {
  assert.match(validateSettingsForm(form({ endpoint: "not-a-url" }), false)!, /endpoint/i);
  assert.match(validateSettingsForm(form({ model: "" }), false)!, /model/i);
  assert.match(validateSettingsForm(form({ apiKey: "" }), false)!, /API key/i);
  assert.strictEqual(validateSettingsForm(form({ apiKey: "" }), true), null);
  // A local Ollama endpoint needs no key.
  assert.strictEqual(
    validateSettingsForm(form({ endpoint: "http://127.0.0.1:11434/v1/chat/completions", apiKey: "" }), false),
    null,
  );
});

test("settings-model: connection and save errors are plain, with no stack or CLI advice", () => {
  assert.match(connectionError(401), /API key/i);
  assert.match(connectionError(404), /endpoint or model/i);
  assert.match(connectionError(500), /provider/i);
  assert.match(connectionError(undefined, "fetch failed ECONNREFUSED"), /reach the provider/i);
  assert.match(connectionError(undefined, "Error: use --api-key to set a key\n at file.ts:1"), /check the endpoint/i);
  for (const message of [connectionError(401, "use --api-key"), saveErrorMessage(new Error(" --model stack"))]) {
    assert.ok(!message.includes("--"), message);
    assert.ok(!message.includes("at "), message);
  }
  assert.match(saveErrorMessage(new Error("Bad Request")), /could not save/i);
  assert.match(saveErrorMessage(new Error("fetch failed")), /could not reach/i);
});

test("settings-model: welcome state reflects whether Ollama was found", () => {
  const found = welcomeState({ available: true, models: ["llama3.1"] });
  assert.strictEqual(found.ollamaDetected, true);
  assert.strictEqual(found.localEnabled, true);
  assert.match(found.message, /llama3\.1/);

  const empty = welcomeState({ available: true, models: [] });
  assert.strictEqual(empty.localEnabled, false);
  assert.match(empty.message, /no models/i);

  const missing = welcomeState({ available: false, models: [] });
  assert.strictEqual(missing.ollamaDetected, false);
  assert.strictEqual(missing.localEnabled, false);
  assert.match(missing.message, /not detected/i);
});

test("settings-model: engine choices disable missing binaries with a plain reason", () => {
  assert.strictEqual(ENGINE_OPTIONS.length, 7);
  assert.deepStrictEqual(ENGINE_OPTIONS.map((o) => o.id), [
    "opensand", "claude", "opencode", "codex", "copilot", "antigravity", "workbuddy",
  ]);
  assert.strictEqual(isExternalEngine("opensand"), false);
  assert.strictEqual(isExternalEngine("claude"), true);
  assert.deepStrictEqual(enginePayload("opencode"), { engine: "opencode" });

  const none = resolveEngineChoice("claude", []);
  assert.strictEqual(none.selected, "opensand", "a missing engine falls back to the default");
  assert.strictEqual(none.missing.length, 6);
  assert.match(none.hint, /Claude Code is not installed on this computer/);
  assert.match(none.hint, /WorkBuddy is not installed on this computer/);
  assert.doesNotMatch(none.hint, /npm|CLI|--/);

  const all = resolveEngineChoice("claude", ENGINE_OPTIONS.filter((o) => o.id !== "opensand").map((o) => ({ engine: o.id, installed: true })));
  assert.strictEqual(all.selected, "claude");
  assert.deepStrictEqual(all.missing, []);
  assert.strictEqual(all.hint, "");

  const partial = resolveEngineChoice("codex", [
    { engine: "claude", installed: true },
    { engine: "codex", installed: true },
  ]);
  assert.strictEqual(partial.selected, "codex");
  assert.strictEqual(partial.missing.length, 4);
});

test("settings-model: external engines skip provider-field validation", () => {
  const empty = form({ endpoint: "", model: "", apiKey: "" });
  assert.match(validateSettingsForm(empty, false)!, /endpoint/i);
  const engine: EngineId = "claude";
  assert.strictEqual(validateSettingsForm(empty, false, engine), null);
  assert.strictEqual(validateSettingsForm(empty, false, "opensand") !== null, true);
});

test("savePayload sends only { engine } for an external engine, even with a typed key", () => {
  const form = { provider: "openai" as const, endpoint: "https://x.test/v1", model: "m", apiKey: "sk-FAKE-typed-key" };
  assert.deepEqual(savePayload(form, "claude"), { engine: "claude" });
  assert.doesNotMatch(JSON.stringify(savePayload(form, "codex")), /sk-FAKE|apiKey|endpoint/);
  assert.equal(savePayload(form, "opensand").apiKey, "sk-FAKE-typed-key");
});

test("loadEngineStatus survives a rejected detection and keeps OpenSand selectable", async () => {
  const r = await loadEngineStatus(async () => { throw new Error("fetch failed ECONNREFUSED /secret/path"); });
  assert.equal(r.unavailable, true);
  assert.deepEqual(r.detected, []);
  assert.equal(resolveEngineChoice("claude", r.detected).selected, "opensand");
  assert.doesNotMatch(ENGINE_STATUS_UNAVAILABLE, /ECONNREFUSED|fetch failed/);
  assert.deepEqual(await loadEngineStatus(undefined), { detected: [], unavailable: false });
});

test("toEngineStatus is an allowlist", () => {
  const out = toEngineStatus([{ engine: "claude", installed: true, authenticated: true, binaryPath: "/x", version: "1" } as any]);
  assert.deepEqual(out, [{ engine: "claude", installed: true, signedIn: true }]);
});

test("SettingsView is wired through the tested helpers, not the raw payload or raw detection", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../renderer-next/src/views/SettingsView.tsx", import.meta.url), "utf8");
  assert.match(src, /saveSettings\(savePayload\(form, engine\)\)/);
  assert.match(src, /loadEngineStatus\(/);
  assert.doesNotMatch(src, /await data\.detectEngines\(\)/);
});
