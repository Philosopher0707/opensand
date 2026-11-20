/** Kimi CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const KimiAgentDriver = defineAcpDriver({
  driverKind: "kimiAgent",
  displayName: "Kimi",
  cli: "kimi",
  spawnArgs: () => ["acp"],
  models: {
    default: "kimi-code/k3",
    options: [
      { id: "kimi-code/k3", label: "Kimi Code K3" },
      { id: "kimi-code/k3-256k", label: "Kimi Code K3 256K" },
      { id: "kimi-for-coding", label: "Kimi for Coding" },
      { id: "kimi-for-coding-highspeed", label: "Kimi for Coding Highspeed" },
    ],
  },
  modelConfigId: "model",
});
