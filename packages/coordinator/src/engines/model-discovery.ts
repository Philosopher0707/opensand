import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type EngineModel = { id: string; label: string };
export type ModelDiscovery = { models: EngineModel[]; modelsSource: "live" | "fallback" | "error"; modelsMessage?: string };

const FALLBACKS: Record<string, EngineModel[]> = {
  opensand: [{ id: "gpt-4o-mini", label: "GPT-4o mini" }],
  claude: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"].map((id) => ({ id, label: id })),
  codex: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
  copilot: [{ id: "claude-sonnet-4", label: "Claude Sonnet 4" }],
  antigravity: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }],
  opencode: [{ id: "opencode/big-pickle", label: "OpenCode Big Pickle" }],
  workbuddy: ["fast-model", "balanced-model", "primary-model", "deep-model"].map((id) => ({ id, label: id })),
};

const cache = new Map<string, { expires: number; value: ModelDiscovery }>();
const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;

function normalizeModels(value: unknown): EngineModel[] {
  const rows = Array.isArray(value) ? value : (value as any)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: any) => {
    const id = typeof row === "string" ? row : (row?.id ?? row?.model ?? row?.name);
    if (typeof id !== "string" || !id.trim()) return [];
    const label = typeof row === "object" && typeof row?.name === "string" && row.name.trim() ? row.name.trim() : id.trim();
    return [{ id: id.trim().slice(0, 256), label: label.slice(0, 256) }];
  }).filter((m, i, all) => all.findIndex((other) => other.id === m.id) === i).slice(0, 500);
}

function runListCommand(binary: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (value: string | null) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(value); } };
    let child;
    try { child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
    catch { return done(null); }
    timer = setTimeout(() => { child.kill("SIGKILL"); done(null); }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (output.length < 256_000) output += chunk.toString(); });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? output : null));
  });
}

function parseCliModels(engine: string, output: string): EngineModel[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return normalizeModels(JSON.parse(trimmed)); } catch { /* parse line output below */ }
  }
  if (engine === "opencode") {
    return trimmed.split(/\r?\n/).map((line) => line.trim().split(/\s{2,}/)[0])
      .filter((id) => /^[\w.-]+\/[\w./:-]+$/.test(id))
      .map((id) => ({ id, label: id }));
  }
  return normalizeModels(trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w./:-]+$/.test(line)));
}

export interface ModelDiscoveryOptions {
  engine: string;
  binary?: string | null;
  endpoint?: string;
  provider?: "openai" | "anthropic" | "openrouter";
  apiKey?: string;
  fetcher?: typeof fetch;
  commandRunner?: (binary: string, args: string[], timeoutMs?: number) => Promise<string | null>;
  cache?: boolean;
}

/** Model discovery is read-only: it never emits provider or CLI error text to the renderer. */
export async function listModels(options: ModelDiscoveryOptions): Promise<ModelDiscovery> {
  const { engine } = options;
  const accountTag = options.apiKey && options.apiKey !== "none" && options.apiKey !== "********"
    ? createHash("sha256").update(options.apiKey).digest("hex") : "no-key";
  const cacheKey = engine === "opensand" ? `${engine}:${options.provider}:${options.endpoint}:${accountTag}` : engine;
  const cached = cache.get(cacheKey);
  if (options.cache !== false && cached && cached.expires > Date.now()) return cached.value;
  let live: EngineModel[] = [];
  let failed = false;
  let empty = false;
  if (engine === "opensand" && options.endpoint) {
    try {
      const base = options.endpoint.replace(/\/+$/, "");
      const url = `${base}/models`;
      const headers: Record<string, string> = {};
      if (options.apiKey && options.apiKey !== "none" && options.apiKey !== "********") {
        if (options.provider === "anthropic") { headers["x-api-key"] = options.apiKey; headers["anthropic-version"] = "2023-06-01"; }
        else headers.Authorization = `Bearer ${options.apiKey}`;
      }
      const response = await (options.fetcher ?? fetch)(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) failed = true;
      else {
        live = normalizeModels(await response.json());
        empty = live.length === 0;
      }
      if (!live.length && !empty) failed = true;
    } catch { failed = true; }
  } else if (engine === "opencode" && options.binary) {
    // OpenCode ships a non-interactive model-list command. The account CLIs do not, so they
    // deliberately use the clearly labelled built-in catalogs above.
    const output = await (options.commandRunner ?? runListCommand)(options.binary, ["models", "--verbose"], TIMEOUT_MS);
    if (output !== null) live = parseCliModels(engine, output);
    if (!live.length) { failed = true; empty = output !== null; }
  }
  const models = live.length ? live : (FALLBACKS[engine] ?? []);
  const value: ModelDiscovery = {
    models,
    modelsSource: live.length ? "live" : models.length ? "fallback" : "error",
    ...(!live.length ? {
      modelsMessage: models.length
        ? (empty ? "No models were returned; showing a built-in fallback list." : "Live model list unavailable; showing a built-in fallback list.")
        : "No model list is available for this engine.",
    } : {}),
  };
  if (options.cache !== false) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { expires: Date.now() + CACHE_MS, value });
  }
  return value;
}
