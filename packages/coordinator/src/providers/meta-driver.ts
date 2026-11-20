/** Meta Muse OpenAI-compatible API driver. */

import type { ModelCatalog } from "@opensand/shared";
import { defineApiDriver } from "./factories/api-driver.js";

const MODELS: ModelCatalog = {
  default: "muse-wonder-1.0",
  options: [
    { id: "muse-wonder-1.0", label: "Muse Wonder 1.0" },
    { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
    { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
  ],
};

export const MetaDriver = defineApiDriver({
  driverKind: "meta",
  displayName: "Meta Muse (API)",
  url: "https://api.meta.ai/v1",
  apiKeyEnv: "META_API_KEY",
  models: MODELS,
  style: "openrouter",
});
