import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebhookGateway } from "../src/webhook-gateway.js";

describe("real agent executors", () => {
  it("webhook agent target calls the injected executor with the target agent", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-webhook-exec-"));
    try {
      const gateway = new WebhookGateway({ storageDir: tmpDir });
      gateway.registerWebhook({
        id: "wh-ci",
        name: "ci-failure",
        targetType: "agent",
        targetId: "agent_ci_bot_ab12cd34",
        enabled: true,
      });
      let seen: { agentId?: string; source?: string; prompt: string } | undefined;
      gateway.setAgentExecutor({
        async runTurn(input) {
          seen = input;
          return "investigated by real turn";
        },
      });
      const result = await gateway.handleWebhook("ci-failure", { build: 42 }, {});
      assert.strictEqual(result.success, true);
      assert.strictEqual(seen?.agentId, "agent_ci_bot_ab12cd34");
      assert.strictEqual(seen?.source, "webhook");
      assert.match(seen?.prompt ?? "", /build/);
      assert.strictEqual((result.output as any)?.response, "investigated by real turn");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
