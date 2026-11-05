import { describe, it } from "node:test";
import * as assert from "node:assert";
import { SlackClient, LinearClient, sourceLabelFor } from "../src/provider-clients.js";

/**
 * The point of these tests is the failure paths. Both providers report
 * application errors with HTTP 200, so a client that trusts the status code will
 * report success for a message that was never posted or an issue that was never
 * created — which is exactly what the previous implementations did.
 */
describe("SlackClient", () => {
  it("reports unconnected when no token is present, without pretending", async () => {
    const client = new SlackClient({ token: "" });
    assert.strictEqual(client.isConnected(), false);

    const res = await client.postMessage("#general", "hi");
    const err = res as { ok: boolean; unconnected?: boolean };
    assert.strictEqual(err.ok, false);
    assert.strictEqual(err.unconnected, true);
  });

  it("rejects empty channel or text before sending", async () => {
    const client = new SlackClient({ token: "xoxb-fake" });
    const noChannel = await client.postMessage("", "hi");
    assert.strictEqual((noChannel as { ok: boolean }).ok, false);
    assert.match((noChannel as { message: string }).message, /non-empty channel/);

    const noText = await client.postMessage("#general", "   ");
    assert.strictEqual((noText as { ok: boolean }).ok, false);
    assert.match((noText as { message: string }).message, /non-empty text/);
  });

  it("treats HTTP 200 with ok:false as a failure", async () => {
    const client = new SlackClient({ token: "xoxb-fake" });
    const res = await client.postMessage("#general", "hi");
    const err = res as { ok: boolean; status: number; message: string };

    // Either a transport error or a Slack app error — never success.
    assert.strictEqual(err.ok, false, "a fake token must never yield success");
    assert.ok(typeof err.message === "string" && err.message.length > 0);
  });

  it("labels credential kinds, and flags app-level tokens as unusable", () => {
    assert.match(sourceLabelFor("xoxb-1", "slack"), /bot token/);
    assert.match(sourceLabelFor("xapp-1", "slack"), /cannot post as a bot/);
    assert.match(sourceLabelFor("", "slack"), /none/);
  });
});

describe("LinearClient", () => {
  it("reports unconnected when no key is present", async () => {
    const client = new LinearClient({ token: "" });
    assert.strictEqual(client.isConnected(), false);

    const res = await client.createIssue({ title: "x" });
    assert.strictEqual((res as { ok: boolean }).ok, false);
    assert.strictEqual((res as { unconnected?: boolean }).unconnected, true);
  });

  it("rejects an empty title before spending a request", async () => {
    const client = new LinearClient({ token: "lin_api_fake" });
    const res = await client.createIssue({ title: "  " });
    assert.strictEqual((res as { ok: boolean }).ok, false);
    assert.match((res as { message: string }).message, /non-empty title/);
  });

  it("never invents an identifier from a fake key", async () => {
    const client = new LinearClient({ token: "lin_api_fake" });
    const res = await client.createIssue({ title: "Real title", teamKey: "ENG" });
    const err = res as { ok: boolean; identifier?: string; message: string };
    assert.strictEqual(err.ok, false, "a fake key must never yield an issue");
    // The old code returned e.g. "ENG-437" here.
    assert.strictEqual(err.identifier, undefined);
  });

  it("labels credential kinds", () => {
    assert.match(sourceLabelFor("lin_api_x", "linear"), /personal API key/);
    assert.match(sourceLabelFor(null, "linear"), /none/);
  });
});
