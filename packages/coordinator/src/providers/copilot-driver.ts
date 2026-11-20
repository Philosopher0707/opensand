/** GitHub Copilot CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const CopilotDriver = defineAcpDriver({
  driverKind: "copilotAgent",
  displayName: "GitHub Copilot",
  cli: "copilot",
  spawnArgs: () => ["--acp", "--stdio"],
  models: {
    default: "auto",
    options: [{ id: "auto", label: "Auto" }],
  },
  modelConfigId: "model",
  auth: {
    provider: "copilot",
    homeEnv: "COPILOT_CONFIG_DIR",
    homeDir: ".copilot",
    loginArgs: ["auth", "login"],
    statusArgs: ["auth", "status"],
    logoutArgs: ["auth", "logout"],
    urlPattern: /https:\/\/github\.com\/login\/\S+/i,
    codePattern: /\b[A-Z0-9]{4,12}\b/,
    requiresCode: false,
    failureMessage: "GitHub Copilot sign-in failed. Check the CLI output in Settings.",
  },
});
