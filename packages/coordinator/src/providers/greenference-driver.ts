/** Greenference OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "greenference/glm-5.3-flash",
  options: [
    { id: "greenference/glm-5.3-flash", label: "GLM 5.3 Flash" },
    { id: "greenference/qwen3.6-27b", label: "Qwen 3.6 27B" },
    { id: "greenference/gemma-4-31b-it", label: "Gemma 4 31B IT" },
    { id: "greenference/glm-4.7-flash", label: "GLM 4.7 Flash" },
    { id: "greenference/qwen3-14b", label: "Qwen 3 14B" },
  ],
};

export const GreenferenceDriver = defineApiDriver({
  driverKind: "greenference",
  displayName: "Greenference (API)",
  url: "https://llm.eu.greenference.com/v1",
  apiKeyEnv: "GREENFERENCE_API_KEY",
  models: MODELS,
  style: "openrouter",
});
