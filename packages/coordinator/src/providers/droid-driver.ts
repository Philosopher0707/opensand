/** Droid CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const DroidDriver = defineAcpDriver({
  driverKind: "droidAgent",
  displayName: "Droid",
  cli: "droid",
  spawnArgs: () => ["exec", "-o", "acp"],
  models: {
    default: "claude-opus-5",
    options: [
      { id: "auto", label: "Auto" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
      { id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT 5.6 Terra" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
      { id: "glm-5.2", label: "GLM 5.2" },
      { id: "kimi-k3", label: "Kimi K3" },
      { id: "grok-4.6", label: "Grok 4.6" },
    ],
  },
});
