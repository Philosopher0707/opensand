/** Cursor CLI driver over the ACP protocol. */

import { defineAcpDriver } from "./factories/acp-driver.js";

export const CursorDriver = defineAcpDriver({
  driverKind: "cursorAgent",
  displayName: "Cursor",
  cli: "cursor-agent",
  spawnArgs: () => ["acp"],
  models: {
    default: "auto",
    options: [
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
      { id: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
      { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 Thinking High" },
    ],
  },
  modelConfigId: "model",
});
