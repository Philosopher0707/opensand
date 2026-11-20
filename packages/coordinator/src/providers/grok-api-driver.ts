/** Grok (xAI) OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

export const GrokApiDriver = defineApiDriver({
  driverKind: "grok",
  displayName: "Grok (API)",
  url: "https://api.x.ai/v1",
  apiKeyEnv: "XAI_API_KEY",
  models: MODELS,
  style: "openrouter",
});
