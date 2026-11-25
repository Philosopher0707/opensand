import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { DETECTABLE_ENGINE_IDS, listModels } from "@opensand/coordinator";
import { DesktopServer } from "../src/desktop-server.js";
import { selectedEngineConfig } from "../src/shell/settings-model.js";
import { closeThenRemove } from "./teardown.js";

class MockRequest extends EventEmitter {
  method = "GET";
  url = "/api/engines/detect";
  headers = { host: "127.0.0.1:3456" };
  socket = { remoteAddress: "127.0.0.1" };
}
class MockResponse extends EventEmitter {
  statusCode = 200;
  body = "";
  setHeader() {}
  writeHead(code: number) { this.statusCode = code; }
  end(body?: string) { this.body = body ?? ""; }
}

test("engine-model-discovery.test.ts returns model catalogs from the production detect route and persists the next-turn selection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-model-discovery-"));
  const server = new DesktopServer({ baseDir: path.join(tmp, "state"), requireAuth: false });
  try {
    server.getBridge().detectEngines = async () => [
      { engine: "opensand", label: "OpenSand", installed: true, binaryPath: null, version: null, versionStatus: "unchecked", authenticated: false, models: [{ id: "provider/model-live", label: "Provider Live" }], modelsSource: "live" },
      { engine: "opencode", label: "OpenCode", installed: true, binaryPath: null, version: null, versionStatus: "unchecked", authenticated: false, models: [{ id: "acme/model-live", label: "acme/model-live" }], modelsSource: "live" },
    ];
    const req = new MockRequest();
    const res = new MockResponse();
    const pending = (server as any).handleRequest(req, res);
    req.emit("end");
    await pending;
    assert.equal(res.statusCode, 200);
    const engines = JSON.parse(res.body);
    const providerEngine = engines.find((engine: any) => engine.engine === "opensand");
    const cliEngine = engines.find((engine: any) => engine.engine === "opencode");
    assert.deepEqual(providerEngine.models, [{ id: "provider/model-live", label: "Provider Live" }]);
    assert.equal(providerEngine.modelsSource, "live");
    assert.deepEqual(cliEngine.models, [{ id: "acme/model-live", label: "acme/model-live" }]);
    assert.equal(cliEngine.modelsSource, "live");

    server.getBridge().updateSettings({ engine: "opencode", engineModels: { opencode: "acme/model-live" } });
    const reloadedServer = new DesktopServer({ baseDir: path.join(tmp, "state"), requireAuth: false });
    const saved = reloadedServer.getBridge().getSanitizedSettings();
    assert.equal(saved.engineModels?.opencode, "acme/model-live");
    assert.deepEqual(selectedEngineConfig(saved.engine, saved.engineModels), { type: "external", engine: "opencode", model: "acme/model-live" });
    await reloadedServer.getBridge().close();
  } finally {
    await closeThenRemove([server, server.getBridge()], tmp);
  }
});

test("every engine returned by detection has a current labelled fallback catalog", async () => {
  const staleIds = new Set(["gpt-4o-mini", "claude-sonnet-4-5", "claude-opus-4-1", "gpt-5-codex", "gemini-2.5-pro", "opencode/big-pickle"]);
  for (const engine of ["opensand", ...DETECTABLE_ENGINE_IDS] as const) {
    const result = await listModels({
      engine,
      binary: engine === "opensand" ? null : "/fake/account-cli",
      cache: false,
      commandRunner: async () => null,
    });
    assert.equal(result.modelsSource, "fallback", engine);
    assert.ok(result.models.length > 0, `${engine} must offer at least one account model`);
    const noListMessages: Record<string, string> = {
      claude: "Claude Code doesn't publish a model list; showing current models.",
      codex: "Codex doesn't publish a model list; showing current models.",
      copilot: "GitHub Copilot doesn't publish a model list; showing current models.",
      workbuddy: "WorkBuddy doesn't publish a model list; showing current models.",
    };
    if (noListMessages[engine]) assert.equal(result.modelsMessage, noListMessages[engine], engine);
    else assert.match(result.modelsMessage!, /built-in fallback list/i, engine);
    assert.ok(result.models.every((model) => !staleIds.has(model.id)), `${engine} fallback still contains a stale model id`);
  }
});

test("API and CLI adapters parse successful live model catalogs", async () => {
  const provider = await listModels({ engine: "opensand", endpoint: "https://provider.invalid/v1", cache: false, fetcher: async () => new Response(JSON.stringify({ data: [{ id: "vendor/model-a", name: "Model A" }] }), { status: 200 }) });
  assert.equal(provider.modelsSource, "live");
  assert.deepEqual(provider.models, [{ id: "vendor/model-a", label: "Model A" }]);

  const cli = await listModels({ engine: "opencode", binary: "/fake/opencode", cache: false, commandRunner: async (_binary, args) => {
    assert.deepEqual(args, ["api", "model.list"]);
    return JSON.stringify({ data: [{ providerID: "vendor", modelID: "model-b", name: "Model B" }] });
  } });
  assert.equal(cli.modelsSource, "live");
  assert.deepEqual(cli.models, [{ id: "vendor/model-b", label: "Model B" }]);
  assert.ok(!cli.models.some((model) => model.id === "opencode-go/glm-5.3-flash"));

  const antigravity = await listModels({ engine: "antigravity", binary: "/fake/agy", cache: false, commandRunner: async (_binary, args) => {
    assert.deepEqual(args, ["models"]);
    return "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n";
  } });
  assert.equal(antigravity.modelsSource, "live");
  assert.deepEqual(antigravity.models, [{ id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" }]);
});

test("fallback catalogs are used only after live listing fails", async () => {
  const failed = await listModels({ engine: "opencode", binary: "/fake/opencode", cache: false, commandRunner: async () => null });
  assert.equal(failed.modelsSource, "fallback");
  assert.deepEqual(failed.models, [{ id: "opencode-go/glm-5.3-flash", label: "GLM 5.3 Flash" }]);
  assert.equal(failed.modelsMessage, "Live model list unavailable; showing a built-in fallback list.");
});

test("provider 401, outage, empty response and CLI timeout use safe fallback catalogs", async () => {
  const response = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
  const unauthorized = await listModels({ engine: "opensand", endpoint: "http://provider.invalid/v1", cache: false, fetcher: async () => response(401, { error: "SECRET_RAW_PROVIDER_ERROR" }) });
  assert.equal(unauthorized.modelsSource, "fallback");
  assert.match(unauthorized.modelsMessage!, /fallback/i);
  assert.doesNotMatch(JSON.stringify(unauthorized), /SECRET_RAW_PROVIDER_ERROR/);

  const offline = await listModels({ engine: "opensand", endpoint: "http://provider.invalid/v1", cache: false, fetcher: async () => { throw new Error("SECRET_RAW_NETWORK_ERROR"); } });
  assert.equal(offline.modelsSource, "fallback");
  assert.doesNotMatch(JSON.stringify(offline), /SECRET_RAW_NETWORK_ERROR/);

  const empty = await listModels({ engine: "opensand", endpoint: "http://provider.invalid/v1", cache: false, fetcher: async () => response(200, { data: [] }) });
  assert.equal(empty.modelsSource, "fallback");
  assert.match(empty.modelsMessage!, /No models were returned/i);

  const timeout = await listModels({ engine: "opencode", binary: "/fake/opencode", cache: false, commandRunner: async () => null });
  assert.equal(timeout.modelsSource, "fallback");
  assert.ok(timeout.models.length > 0);
  const noFallback = await listModels({ engine: "unknown-engine", cache: false });
  assert.equal(noFallback.modelsSource, "error");
  assert.deepEqual(noFallback.models, []);
  assert.match(noFallback.modelsMessage!, /no model list is available/i);
});

test("saved models no longer offered remain selected and both Settings renderers use a model dropdown", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(here, "../../renderer-next/src/views/SettingsView.tsx"), "utf8");
  assert.match(source, /savedModelStale/);
  assert.match(source, /no longer offered/);
  assert.match(source, /<select[\s\S]*?id=\{id\("Model"\)\}/);
  assert.match(source, /Loading models…/);
  assert.match(source, /No models are available for this engine/);

  // The production default is still the legacy renderer; it must expose the same account-model choice.
  const legacyHtml = fs.readFileSync(path.resolve(here, "../../renderer/index.html"), "utf8");
  const legacyJs = fs.readFileSync(path.resolve(here, "../../renderer/app.js"), "utf8");
  assert.match(legacyHtml, /<select id="settingEngineModel"/);
  assert.match(legacyJs, /renderEngineModelChoices/);
  assert.match(legacyJs, /payload\.engineModels = \{ \.\.\.engineModels, \[selectedEngine\]: settingEngineModel\.value \}/);
});
