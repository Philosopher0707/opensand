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
});
