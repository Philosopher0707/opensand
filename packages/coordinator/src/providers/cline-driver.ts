/** Cline CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const ClineDriver = defineAcpDriver({
  driverKind: "clineAgent",
  displayName: "Cline",
  cli: "cline",
  spawnArgs: () => ["--acp", "--auto-approve", "false"],
  models: {
    default: "cline-default",
    options: [{ id: "cline-default", label: "Cline Default" }],
  },
});
