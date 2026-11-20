/** Cerebras OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "gpt-oss-120b",
  options: [
    { id: "gpt-oss-120b", label: "GPT-OSS 120B" },
    { id: "qwen-3.8-27b", label: "Qwen 3.8 27B" },
  ],
};

export const CerebrasDriver = defineApiDriver({
  driverKind: "cerebras",
  displayName: "Cerebras (API)",
  url: "https://api.cerebras.ai/v1",
  apiKeyEnv: "CEREBRAS_API_KEY",
  models: MODELS,
  style: "openrouter",
});
