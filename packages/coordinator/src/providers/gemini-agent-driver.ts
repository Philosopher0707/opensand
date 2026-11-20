/** Gemini CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const GeminiAgentDriver = defineAcpDriver({
  driverKind: "geminiAgent",
  displayName: "Gemini",
  cli: "gemini",
  spawnArgs: () => ["--acp"],
  models: {
    default: "gemini-2.5-pro",
    options: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
});
