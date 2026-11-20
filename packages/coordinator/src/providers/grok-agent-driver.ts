/** Grok CLI driver over the ACP stdio protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const GrokAgentDriver = defineAcpDriver({
  driverKind: "grokAgent",
  displayName: "Grok",
  cli: "grok",
  spawnArgs: (config) => [
    "--permission-mode",
    config.fullAuto ? "bypassPermissions" : "default",
    "agent",
    "stdio",
  ],
  models: {
    default: "grok-4.7",
    options: [
      { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ],
  },
  modelConfigId: "model",
  auth: {
    provider: "grok",
    homeEnv: "GROK_HOME",
    homeDir: ".grok",
    loginArgs: ["login", "--device-auth"],
    signedInFile: "auth.json",
    urlPattern: /https:\/\/(?:x\.ai|grok\.com)\/\S+/i,
    codePattern: /\b[A-Z0-9]{4,12}\b/,
    failureMessage: "Grok device sign-in failed. Check the CLI output in Settings.",
  },
});
