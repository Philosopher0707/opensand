/** DeepSeek Harness CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const DeepSeekDriver = defineAcpDriver({
  driverKind: "deepseekAgent",
  displayName: "DeepSeek Harness",
  cli: "dsh",
  spawnArgs: () => ["--profile", "acp"],
  models: {
    default: "deepseek-official/deepseek-v4-flash",
    options: [
      { id: "deepseek-official/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "deepseek-official/deepseek-flash", label: "DeepSeek Flash" },
      { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
  },
  modelConfigId: "model",
});
