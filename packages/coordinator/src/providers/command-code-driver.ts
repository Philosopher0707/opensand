/** Command Code CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const CommandCodeDriver = defineAcpDriver({
  driverKind: "commandCodeAgent",
  displayName: "Command Code",
  cli: "command-code",
  spawnArgs: () => ["acp"],
  models: {
    default: "agent-default",
    options: [{ id: "agent-default", label: "Agent Default" }],
  },
});
