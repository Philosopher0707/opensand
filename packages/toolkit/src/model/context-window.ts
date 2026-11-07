import * as fs from "node:fs";
import * as path from "node:path";
import { getModelMaxContextTokens } from "../model/token-hygiene.js";

export interface OpenRouterModelPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
}

export interface OpenRouterModelTopProvider {
  context_length?: number;
  max_completion_tokens?: number;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  description?: string;
  pricing?: OpenRouterModelPricing;
  top_provider?: OpenRouterModelTopProvider;
}

export interface OpenRouterCatalogOptions {
  cacheDir?: string;
  ttlMs?: number; // default: 1 hour (3,600,000 ms)
  fetchFn?: typeof globalThis.fetch;
}

/**
 * OpenRouter Model Catalog
 * Automatically fetches, parses, and caches model context limits and metadata
 * directly from OpenRouter's listed models API (GET /api/v1/models).
 */
export class OpenRouterCatalog {
  private models: Map<string, OpenRouterModel> = new Map();
  private aliases: Map<string, string> = new Map();
  private lastFetched: number = 0;
  private ttlMs: number;
  private cacheFilePath?: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(options?: OpenRouterCatalogOptions) {
    this.ttlMs = options?.ttlMs ?? 3600000;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    if (options?.cacheDir) {
      this.initCacheDir(options.cacheDir);
    }
  }

  public initCacheDir(cacheDir: string): void {
    try {
      this.cacheFilePath = path.join(cacheDir, "openrouter-models.json");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      }
      this.loadDiskCache();
    } catch {
      // Non-fatal if cache dir unavailable
    }
  }

  private loadDiskCache(): void {
    if (!this.cacheFilePath || !fs.existsSync(this.cacheFilePath)) return;
    try {
      const raw = fs.readFileSync(this.cacheFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.models) && typeof parsed.timestamp === "number") {
        this.models.clear();
        this.aliases.clear();
        for (const m of parsed.models) {
          if (m?.id && typeof m.context_length === "number") {
            const key = m.id.toLowerCase();
            this.models.set(key, m);
          }
        }
        if (parsed.aliases && typeof parsed.aliases === "object") {
          for (const [alias, id] of Object.entries(parsed.aliases)) {
            this.aliases.set(alias.toLowerCase(), String(id).toLowerCase());
          }
        }
        this.lastFetched = parsed.timestamp;
      }
    } catch {
      // Ignore disk parse errors
    }
  }

  private saveDiskCache(): void {
    if (!this.cacheFilePath) return;
    try {
      const payload = {
        timestamp: this.lastFetched,
        models: Array.from(this.models.values()),
        aliases: Object.fromEntries(this.aliases.entries()),
      };
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Fetch all models from OpenRouter listed models API.
   * If cached recently, returns memory/disk cached models.
   */
  public async fetchModels(
    endpoint?: string,
    apiKey?: string,
    forceRefresh = false
  ): Promise<OpenRouterModel[]> {
    const now = Date.now();
    if (!forceRefresh && this.models.size > 0 && now - this.lastFetched < this.ttlMs) {
      return Array.from(this.models.values());
    }

    let url = "https://openrouter.ai/api/v1/models";
    if (endpoint && endpoint.includes("openrouter.ai")) {
      const clean = endpoint.replace(/\/+$/, "");
      if (clean.endsWith("/models")) {
        url = clean;
      } else if (clean.endsWith("/chat/completions")) {
        url = clean.replace(/\/chat\/completions$/, "/models");
      } else if (clean.endsWith("/v1")) {
        url = `${clean}/models`;
      }
    }

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey && apiKey !== "none") {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await this.fetchFn(url, {
        headers,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        if (this.models.size > 0) return Array.from(this.models.values());
        throw new Error(`OpenRouter models API returned HTTP ${res.status}`);
      }

      const data = await res.json();
      if (Array.isArray(data?.data)) {
        this.models.clear();
        this.aliases.clear();
        for (const item of data.data) {
          if (item?.id && typeof item.context_length === "number") {
            const modelObj: OpenRouterModel = {
              id: item.id,
              name: item.name || item.id,
              context_length: item.context_length,
              description: item.description,
              pricing: item.pricing,
              top_provider: item.top_provider,
            };
            const lowerId = item.id.toLowerCase();
            this.models.set(lowerId, modelObj);
            if (item.canonical_slug) {
              this.aliases.set(item.canonical_slug.toLowerCase(), lowerId);
            }
          }
        }
        this.lastFetched = now;
        this.saveDiskCache();
      }
    } catch {
      // If network fails, return cached entries if any
    }

    return Array.from(this.models.values());
  }

  /**
   * Look up a model by ID (e.g. "deepseek/deepseek-v4.1-flash-1017").
   */
  public getModel(modelId?: string): OpenRouterModel | null {
    if (!modelId) return null;
    const lower = modelId.toLowerCase().trim();
    if (this.models.has(lower)) {
      return this.models.get(lower)!;
    }
    const aliased = this.aliases.get(lower);
    if (aliased && this.models.has(aliased)) {
      return this.models.get(aliased)!;
    }
    // Try matching after slash (e.g. "deepseek-v4.1-flash-1017")
    for (const [key, val] of this.models.entries()) {
      if (key.endsWith("/" + lower) || key === lower) {
        return val;
      }
    }
    return null;
  }

  /**
   * Get exact context length for a model if found in OpenRouter catalog.
   */
  public getContextLength(modelId?: string): number | null {
    let m = this.getModel(modelId);
    if (!m && this.cacheFilePath) {
      this.loadDiskCache();
      m = this.getModel(modelId);
    }
    return m ? m.context_length : null;
  }

  public get size(): number {
    return this.models.size;
  }
}

export const defaultOpenRouterCatalog = new OpenRouterCatalog();

/**
 * Resolves model max context tokens dynamically.
 * Prioritizes OpenRouter listed models if model exists in catalog or endpoint is OpenRouter,
 * falling back to model family heuristics.
 */
export async function resolveModelContextWindow(
  modelName?: string,
  endpoint?: string,
  apiKey?: string,
  catalog: OpenRouterCatalog = defaultOpenRouterCatalog
): Promise<number> {
  if (!modelName) return 128000;

  // 1. Direct cache lookup
  const cachedContext = catalog.getContextLength(modelName);
  if (cachedContext) {
    return cachedContext;
  }

  // 2. If endpoint is OpenRouter or model contains '/', attempt catalog fetch
  const isOpR = (endpoint && endpoint.includes("openrouter.ai")) || modelName.includes("/");
  if (isOpR) {
    try {
      await catalog.fetchModels(endpoint, apiKey);
      const fetchedContext = catalog.getContextLength(modelName);
      if (fetchedContext) {
        return fetchedContext;
      }
    } catch {
      // Fallback
    }
  }

  // 3. Fallback to model family heuristic
  return getModelMaxContextTokens(modelName);
}
