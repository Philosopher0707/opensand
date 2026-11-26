import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type EngineModel = { id: string; label: string };
export type ModelDiscovery = { models: EngineModel[]; modelsSource: "live" | "fallback" | "error"; modelsMessage?: string };

const FALLBACKS: Record<string, EngineModel[]> = {
  opensand: [{ id: "gpt-5.4", label: "GPT-5.4" }],
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => ({ id, label: id })),
  codex: [{ id: "o3", label: "o3" }],
  copilot: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
  antigravity: [{ id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" }],
  opencode: [{ id: "opencode-go/glm-5.3-flash", label: "GLM 5.3 Flash" }],
  workbuddy: ["fast-model", "balanced-model", "primary-model", "deep-model"].map((id) => ({ id, label: id })),
};

const CLI_LIST_COMMANDS: Record<string, string[]> = {
  opencode: ["api", "model.list"],
  antigravity: ["models"],
};

const NO_LIST_MESSAGES: Record<string, string> = {
  claude: "Claude Code doesn't publish a model list; showing current models.",
  codex: "Codex doesn't publish a model list; showing current models.",
  copilot: "GitHub Copilot doesn't publish a model list; showing current models.",
  workbuddy: "WorkBuddy doesn't publish a model list; showing current models.",
};

export const DETECTABLE_ENGINE_IDS = [
  "claude",
  "codex",
  "copilot",
  "antigravity",
  "opencode",
  "workbuddy",
] as const;

const cache = new Map<string, { expires: number; value: ModelDiscovery }>();
const CACHE_MS = 60_000;
const TIMEOUT_MS = 5_000;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CATALOG_ROWS = 500;

function normalizeModels(value: unknown): EngineModel[] {
  const rows = Array.isArray(value) ? value : (value as any)?.data;
  if (!Array.isArray(rows)) return [];
  if (rows.length > MAX_CATALOG_ROWS) throw new Error("Model catalog limit exceeded");
  const models: EngineModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const providerId = typeof row?.providerID === "string" ? row.providerID.trim() : "";
    const modelId = typeof row?.modelID === "string" ? row.modelID.trim() : "";
    const id = providerId && modelId ? `${providerId}/${modelId}` : (typeof row === "string" ? row : (row?.id ?? row?.model ?? row?.name));
    if (typeof id !== "string" || !id.trim()) continue;
    const normalizedId = id.trim().slice(0, 256);
    if (seen.has(normalizedId)) continue;
    seen.add(normalizedId);
    const label = typeof row === "object" && typeof row?.name === "string" && row.name.trim() ? row.name.trim() : id.trim();
    models.push({ id: normalizedId, label: label.slice(0, 256) });
  }
  return models;
}

type DiscoveryFileSystem = Pick<typeof fs, "mkdtemp" | "open" | "readFile" | "rm" | "stat">;

async function runListCommand(binary: string, args: string[], timeoutMs = TIMEOUT_MS, fileSystem: DiscoveryFileSystem = fs): Promise<string | null> {
  let dir: string | undefined;
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    dir = await fileSystem.mkdtemp(path.join(os.tmpdir(), "opensand-model-list-"));
    const outputPath = path.join(dir, "stdout.txt");
    output = await fileSystem.open(outputPath, "w");
    const code = await new Promise<number>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: number) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(value); } };
      let child;
      try { child = spawn(binary, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
      catch { return done(-1); }
      let bytes = 0;
      let writing = false;
      let tooLarge = false;
      const pending: Buffer[] = [];
      const flush = () => {
        if (writing || tooLarge || pending.length === 0) return;
        writing = true;
        const chunk = pending.shift()!;
        void output!.writeFile(chunk).then(() => {
          writing = false;
          if (pending.length) flush();
          else child.stdout?.resume();
        }, () => {
          tooLarge = true;
          child.kill("SIGKILL");
        });
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_CATALOG_BYTES) {
          tooLarge = true;
          child.stdout?.pause();
          child.kill("SIGKILL");
          return;
        }
        pending.push(chunk);
        child.stdout?.pause();
        flush();
      });
      timer = setTimeout(() => { child.kill("SIGKILL"); done(124); }, timeoutMs);
      child.on("error", () => done(-1));
      child.on("close", (value) => done(tooLarge ? -2 : value ?? -1));
    });
    if (code !== 0) return null;
    const metadata = await fileSystem.stat(outputPath);
    if (metadata.size > MAX_CATALOG_BYTES) return null;
    const stat = await fileSystem.readFile(outputPath);
    if (stat.byteLength > MAX_CATALOG_BYTES) return null;
    return stat.toString("utf8");
  } catch {
    return null;
  } finally {
    try { await output?.close(); } catch { /* cleanup is best effort */ }
    if (dir) try { await fileSystem.rm(dir, { recursive: true, force: true }); } catch { /* cleanup is best effort */ }
  }
}

function parseCliModels(engine: string, output: string): EngineModel[] {
  if (Buffer.byteLength(output, "utf8") > MAX_CATALOG_BYTES) throw new Error("Model catalog limit exceeded");
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try { return normalizeModels(JSON.parse(trimmed)); } catch { /* parse line output below */ }
  }
  let lineCount = trimmed ? 1 : 0;
  for (let i = 0; i < trimmed.length; i++) if (trimmed.charCodeAt(i) === 10) lineCount++;
  if (lineCount > MAX_CATALOG_ROWS) throw new Error("Model catalog limit exceeded");
  if (engine === "antigravity") {
    return trimmed.split(/\r?\n/).map((line) => line.trim().split(/\t| {2,}/))
      .filter(([id]) => /^[\w./:-]+$/.test(id || ""))
      .map(([id, label]) => ({ id, label: label || id }));
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
  cliFileSystem?: DiscoveryFileSystem;
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
        if (Number(response.headers.get("content-length")) > MAX_CATALOG_BYTES) throw new Error("Model catalog limit exceeded");
        if (!response.body) throw new Error("Model catalog unavailable");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            bytes += chunk.byteLength;
            if (bytes > MAX_CATALOG_BYTES) {
              await reader.cancel();
              throw new Error("Model catalog limit exceeded");
            }
            chunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
        live = normalizeModels(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))));
        empty = live.length === 0;
      }
      if (!live.length && !empty) failed = true;
    } catch { failed = true; }
  } else if (CLI_LIST_COMMANDS[engine] && options.binary) {
    const args = CLI_LIST_COMMANDS[engine];
    let output: string | null = null;
    try {
      output = options.commandRunner
        ? await options.commandRunner(options.binary, args, TIMEOUT_MS)
        : await runListCommand(options.binary, args, TIMEOUT_MS, options.cliFileSystem);
      if (output !== null) live = parseCliModels(engine, output);
    } catch { failed = true; }
    if (!live.length) { failed = true; empty = output !== null; }
  }
  const models = live.length ? live : (FALLBACKS[engine] ?? []);
  const value: ModelDiscovery = {
    models,
    modelsSource: live.length ? "live" : models.length ? "fallback" : "error",
    ...(!live.length ? {
      modelsMessage: models.length
        ? (NO_LIST_MESSAGES[engine] ?? (empty ? "No models were returned; showing a built-in fallback list." : "Live model list unavailable; showing a built-in fallback list."))
        : "No model list is available for this engine.",
    } : {}),
  };
  if (options.cache !== false) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { expires: Date.now() + CACHE_MS, value });
  }
  return value;
}
