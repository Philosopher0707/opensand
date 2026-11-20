/** Mistral OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "mistral-large-latest",
  options: [
    { id: "mistral-large-latest", label: "Mistral Large" },
    { id: "mistral-small-latest", label: "Mistral Small" },
  ],
};

export const MistralDriver = defineApiDriver({
  driverKind: "mistral",
  displayName: "Mistral (API)",
  url: "https://api.mistral.ai/v1",
  apiKeyEnv: "MISTRAL_API_KEY",
  models: MODELS,
  style: "openrouter",
});
