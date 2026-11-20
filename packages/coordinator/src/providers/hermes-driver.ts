/** Hermes CLI driver over the ACP protocol. Model catalog is dynamic at runtime. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const HermesDriver = defineAcpDriver({
  driverKind: "hermesAgent",
  displayName: "Hermes",
  cli: "hermes",
  spawnArgs: () => ["acp"],
  models: {
    default: "",
    options: [],
  },
});
