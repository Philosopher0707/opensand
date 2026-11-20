/** MiniMax OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3" },
    { id: "MiniMax-M2.7", label: "MiniMax M2.7" },
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed" },
  ],
};

export const MinimaxDriver = defineApiDriver({
  driverKind: "minimax",
  displayName: "MiniMax (API)",
  url: "https://api.minimax.io/v1",
  apiKeyEnv: "MINIMAX_API_KEY",
  models: MODELS,
  style: "openrouter",
});
