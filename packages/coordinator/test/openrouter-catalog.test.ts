import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  OpenRouterCatalog,
  resolveModelContextWindow,
} from "../src/openrouter-catalog.js";

describe("OpenRouter Model Catalog & Context Window Resolver", () => {
  it("fetches and caches models from mock OpenRouter API", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrouter-test-"));

    const mockApiResponse = {
      data: [
        {
          id: "deepseek/deepseek-v4.1-flash-1017",
          name: "DeepSeek V4.1 Flash",
          context_length: 1048576,
          canonical_slug: "deepseek/deepseek-v4.1-flash-20261017",
        },
        {
          id: "meta-llama/llama-3.3-70b-instruct",
          name: "Llama 3.3 70B",
          context_length: 131072,
        },
        {
          id: "qwen/qwen-2.5-coder-32b-instruct",
          name: "Qwen 2.5 Coder 32B",
          context_length: 32768,
        },
      ],
    };

    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify(mockApiResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const catalog = new OpenRouterCatalog({
      cacheDir: tmpDir,
      fetchFn: mockFetch as any,
    });

    // 1. Initial fetch
    const models = await catalog.fetchModels("https://openrouter.ai/api/v1");
    assert.strictEqual(models.length, 3);
    assert.strictEqual(fetchCount, 1);

    // Context length lookups
    assert.strictEqual(catalog.getContextLength("deepseek/deepseek-v4.1-flash-1017"), 1048576);
    assert.strictEqual(catalog.getContextLength("meta-llama/llama-3.3-70b-instruct"), 131072);
    assert.strictEqual(catalog.getContextLength("qwen/qwen-2.5-coder-32b-instruct"), 32768);

    // 2. Second fetch within TTL hits memory cache
    await catalog.fetchModels("https://openrouter.ai/api/v1");
    assert.strictEqual(fetchCount, 1);

    // 3. Verify disk cache was written
    const diskCacheFile = path.join(tmpDir, "openrouter-models.json");
    assert.ok(fs.existsSync(diskCacheFile));

    // 4. Verify disk cache loads into a new catalog instance without network fetch
    const offlineCatalog = new OpenRouterCatalog({
      cacheDir: tmpDir,
      fetchFn: (async () => {
        throw new Error("Network should not be called");
      }) as any,
    });
    assert.strictEqual(offlineCatalog.getContextLength("deepseek/deepseek-v4.1-flash-1017"), 1048576);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolveModelContextWindow dynamically uses OpenRouter catalog over static defaults", async () => {
    const catalog = new OpenRouterCatalog({
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "deepseek/deepseek-v4.1-flash-1017",
                context_length: 1048576,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as any,
    });

    // Model exists in OpenRouter -> returns exact OpenRouter context_length (1048576)
    const deepseekContext = await resolveModelContextWindow(
      "deepseek/deepseek-v4.1-flash-1017",
      "https://openrouter.ai/api/v1",
      undefined,
      catalog
    );
    assert.strictEqual(deepseekContext, 1048576);

    // Unknown local model -> falls back to model family heuristic (e.g. llama3 -> 8192)
    const localLlamaContext = await resolveModelContextWindow(
      "llama-3-8b",
      "http://localhost:11434/v1",
      undefined,
      catalog
    );
    assert.strictEqual(localLlamaContext, 8192);
  });
});
