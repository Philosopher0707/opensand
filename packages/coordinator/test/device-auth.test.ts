import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { GrokAgentDriver } from "../src/providers/grok-agent-driver.js";
import { writeFakeCli } from "./helpers/fake-cli.js";

const FAKE_LOGIN = `
process.stderr.write("Visit https://x.ai/activate?code=ABCD1234 to sign in\\n");
setInterval(() => {}, 1000);
`;

describe("device-auth flows", () => {
  let tmpDir: string;
  let cli: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-auth-test-"));
    cli = await writeFakeCli(tmpDir, "fake-login", FAKE_LOGIN);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("starts a bounded flow, surfaces only allowlisted URL/code, and cancels", { timeout: 20_000 }, async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "auth-test-1",
      displayName: "Auth Test",
      environment: {},
      enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli }),
    });

    assert.equal(instance.authenticationMethod, "device-code");
    const start = instance.startAuthentication;
    const get = instance.getAuthentication;
    const cancel = instance.cancelAuthentication;
    assert.ok(start && get && cancel);

    const flow = await start();
    assert.ok(flow.flowId);
    assert.ok(flow.authorizationUrl?.startsWith("https://x.ai/activate"));
    assert.equal(flow.userCode, "ABCD1234");
    assert.ok(flow.expiresAt);

    const status = await get(flow.flowId as string);
    assert.equal(status.status, "pending");
    assert.equal(status.userCode, "ABCD1234");

    await cancel();
    assert.equal((await get(flow.flowId as string)).status, "cancelled");
    await instance.dispose();
  });

  it("rejects a second concurrent flow", { timeout: 20_000 }, async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "auth-test-2",
      displayName: "Auth Test 2",
      environment: {},
      enabled: true,
      config: GrokAgentDriver.decodeConfig({ cli }),
    });
    const start = instance.startAuthentication;
    assert.ok(start);
    await start();
    await assert.rejects(start(), /already active/);
    await instance.cancelAuthentication?.();
    await instance.dispose();
  });
});
