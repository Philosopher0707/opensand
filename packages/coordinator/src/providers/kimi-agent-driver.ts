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
  auth: {
    provider: "kimi",
    homeEnv: "KIMI_CODE_HOME",
    homeDir: ".kimi-code",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    signedInFile: "credentials/kimi-code.json",
    urlPattern: /https:\/\/(?:kimi\.com|kimi\.moonshot\.cn)\/\S+/i,
    codePattern: /\b[A-Z0-9]{4,12}\b/,
    failureMessage: "Kimi sign-in failed. Check the CLI output in Settings.",
  },
});
