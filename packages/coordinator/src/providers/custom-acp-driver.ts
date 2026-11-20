/** Generic ACP driver whose CLI and spawn args are supplied by the user. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const CustomAcpDriver = defineAcpDriver({
  driverKind: "customAcp",
  displayName: "Custom (ACP)",
  cli: "",
  spawnArgs: () => [],
  models: {
    default: "agent-default",
    options: [{ id: "agent-default", label: "Agent Default" }],
  },
});
