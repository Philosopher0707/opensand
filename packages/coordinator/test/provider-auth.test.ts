import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { startProviderAuth, getProviderAuthStatus, getProviderAuthState, cancelProviderAuth, signOutProvider, disposeProviderAuth } from "../src/provider-auth.js";
import { providerRegistry } from "../src/provider-registry.js";
import { defineAcpDriver } from "../src/providers/factories/acp-driver.js";
import { writeFakeCli } from "./helpers/fake-cli.js";

const FAKE_LOGIN = `
process.stderr.write("Visit https://x.ai/activate?code=ABCD1234 to sign in\\n");
setInterval(() => {}, 1000);
`;

describe("provider-auth production entry point", () => {
  let tmpDir: string;
  let cli: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-provider-auth-"));
    cli = await writeFakeCli(tmpDir, "fake-provider-login", FAKE_LOGIN);
    providerRegistry.register(defineAcpDriver({
      driverKind: "authProdTest",
      displayName: "Auth Prod Test",
      cli,
      spawnArgs: () => ["acp"],
      models: { default: "m", options: [{ id: "m", label: "M" }] },
      auth: {
        provider: "grok",
        homeEnv: "GROK_HOME",
        homeDir: ".grok",
        loginArgs: ["login", "--device-auth"],
        signedInFile: "auth.json",
        urlPattern: /https:\/\/x\.ai\/\S+/i,
        codePattern: /\b[A-Z0-9]{4,12}\b/,
        failureMessage: "Fake sign-in failed",
      },
    }));
  });

  after(async () => {
    await disposeProviderAuth();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("starts, polls, cancels and signs out through the registry", { timeout: 20_000 }, async () => {
    const started = await startProviderAuth("authProdTest");
    assert.ok(started);
    assert.ok(started.flowId);
    assert.ok(String(started.authorizationUrl).startsWith("https://x.ai/activate"));
    assert.equal(started.userCode, "ABCD1234");

    const status = await getProviderAuthStatus("authProdTest", String(started.flowId));
    assert.equal(status?.status, "pending");

    // A second start returns the same pending flow instead of spawning again.
    const again = await startProviderAuth("authProdTest");
    assert.equal(again?.flowId, started.flowId);

    assert.equal(await cancelProviderAuth("authProdTest"), true);
    assert.equal((await getProviderAuthStatus("authProdTest", String(started.flowId)))?.status, "cancelled");
    assert.equal(await signOutProvider("authProdTest"), true);
  });

  it("returns null for providers without a sign-in controller", async () => {
    assert.equal(await startProviderAuth("no-such-provider"), null);
  });

  it("reports observable sign-in state", async () => {
    assert.deepEqual(await getProviderAuthState("authProdTest"), { signedIn: false, flowId: null });
    assert.equal(await getProviderAuthState("no-such-provider"), null);
  });
});
