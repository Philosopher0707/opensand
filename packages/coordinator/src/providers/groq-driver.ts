/** Groq OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "openai/gpt-oss-120b",
  options: [
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
  ],
};

export const GroqDriver = defineApiDriver({
  driverKind: "groq",
  displayName: "Groq (API)",
  url: "https://api.groq.com/openai/v1",
  apiKeyEnv: "GROQ_API_KEY",
  models: MODELS,
  style: "openrouter",
});
