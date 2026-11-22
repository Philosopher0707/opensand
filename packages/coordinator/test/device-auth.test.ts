import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ProviderInstance } from "@opensand/shared";
import { GrokAgentDriver } from "../src/providers/grok-agent-driver.js";
import { writeFakeCli } from "./helpers/fake-cli.js";

const FAKE_LOGIN = `
process.stderr.write("Visit https://x.ai/activate?code=ABCD1234 to sign in\\n");
setInterval(() => {}, 1000);
`;

const FAKE_LOGIN_EXIT = `
import('node:fs').then((fs) => {
  fs.mkdirSync(process.env.GROK_HOME, { recursive: true });
  fs.writeFileSync(process.env.GROK_HOME + '/auth.json', 'token');
  process.stderr.write('Visit https://x.ai/activate?code=ABCD1234 to sign in\\n');
  process.exit(0);
});
`;

describe("device-auth flows", () => {
  let tmpDir: string;
  let cli: string;
  let exitCli: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-auth-test-"));
    cli = await writeFakeCli(tmpDir, "fake-login", FAKE_LOGIN);
    exitCli = await writeFakeCli(tmpDir, "fake-login-exit", FAKE_LOGIN_EXIT);
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

  it("reports authorized after the login CLI exits and shares the credential home", { timeout: 20_000 }, async () => {
    const savedHome = process.env.HOME;
    process.env.HOME = tmpDir;
    let instance: ProviderInstance | undefined;
    let second: ProviderInstance | undefined;
    try {
      instance = await GrokAgentDriver.create({
        instanceId: "auth-exit",
        displayName: "Auth Exit",
        environment: {},
        enabled: true,
        config: GrokAgentDriver.decodeConfig({ cli: exitCli }),
      });

      assert.equal(instance.authenticationMethod, "device-code");
      const start = instance.startAuthentication;
      const get = instance.getAuthentication;
      const isSignedIn = instance.isSignedIn;
      assert.ok(start && get && isSignedIn);

      const flow = await start();
      assert.ok(flow.flowId);
      const deadline = Date.now() + 5_000;
      let status = await get(flow.flowId as string);
      while (status.status !== "authorized" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await get(flow.flowId as string);
      }
      assert.equal(status.status, "authorized");
      assert.equal(await isSignedIn(), true);

      second = await GrokAgentDriver.create({
        instanceId: "auth-exit-2",
        displayName: "Auth Exit 2",
        environment: {},
        enabled: true,
        config: GrokAgentDriver.decodeConfig({ cli: exitCli }),
      });
      assert.equal(await second.isSignedIn?.(), true);
    } finally {
      await second?.dispose();
      await instance?.dispose();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
