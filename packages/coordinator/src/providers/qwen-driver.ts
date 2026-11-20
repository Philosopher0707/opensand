/** Qwen CLI driver over the ACP protocol. Model catalog is dynamic at runtime. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const QwenDriver = defineAcpDriver({
  driverKind: "qwenAgent",
  displayName: "Qwen",
  cli: "qwen",
  spawnArgs: () => ["--acp"],
  models: {
    default: "",
    options: [],
  },
});
