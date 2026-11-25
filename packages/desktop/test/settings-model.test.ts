import test from "node:test";
import assert from "node:assert";
import {
  MASKED_KEY,
  connectionError,
  maskedKey,
  saveErrorMessage,
  settingsPayload,
  validateSettingsForm,
  welcomeState,
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
