/** Generic OpenAI-compatible API driver (via OpenRouter). */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
  ],
};

export const OpenAiCompatDriver = defineApiDriver({
  driverKind: "openai-compat",
  displayName: "Other (OpenAI-compatible)",
  url: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENAI_COMPAT_API_KEY",
  models: MODELS,
  style: "openrouter",
});
