import { describe, it } from "node:test";
import * as assert from "node:assert";
import { GitHubClient, connectorSourceLabel } from "../src/github-client.js";

/**
 * These tests lock the property that matters most about this client: a success
 * result can only come from a real HTTP 2xx, and every failure is reported as a
 * failure. The previous implementation returned `status: "success"` for a mock
 * token without contacting GitHub, which is the defect these replace.
 */
describe("GitHubClient", () => {
  it("reports disconnected when no token is reachable, and says so", async () => {
    const prevPath = process.env.PATH;
    const prevGh = process.env.GITHUB_TOKEN;
    const prevAlt = process.env.GH_TOKEN;
    process.env.PATH = "/nonexistent";
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const client = new GitHubClient();
      assert.strictEqual(client.isConnected(), false);

      const described = client.describe();
      assert.strictEqual(described.connected, false);
      assert.match(described.source, /none/);

      const res = await client.getRepo("acme/repo");
      assert.strictEqual((res as { ok: boolean }).ok, false);
      const err = res as { unconnected?: boolean; message: string };
      assert.strictEqual(err.unconnected, true);
      assert.match(err.message, /not connected/i);
    } finally {
      process.env.PATH = prevPath;
      if (prevGh !== undefined) process.env.GITHUB_TOKEN = prevGh;
      if (prevAlt !== undefined) process.env.GH_TOKEN = prevAlt;
    }
  });

  it("reports a rejected token as 401 unauthorized, never as success", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } })) as typeof globalThis.fetch;
    const client = new GitHubClient({ token: "ghp_definitelynotarealtoken00000000000000" , fetchFn: fakeFetch });
    assert.strictEqual(client.isConnected(), true);

    const res = await client.getRepo("Philosopher0707/wisp");
    const err = res as { ok: boolean; status: number; unauthorized?: boolean };
    assert.strictEqual(err.ok, false);
    assert.strictEqual(err.status, 401);
    assert.strictEqual(err.unauthorized, true);
  });

  it("never exposes the token through describe()", () => {
    const secret = "ghp_supersecretvaluethatshouldnotleak123456";
    const client = new GitHubClient({ token: secret });
    const serialized = JSON.stringify(client.describe());
    assert.ok(!serialized.includes(secret), "describe() leaked the token");
  });

  it("rejects an empty issue title before spending a request", async () => {
    const client = new GitHubClient({ token: "ghp_x" });
    const res = await client.createIssue("acme/repo", "   ");
    const err = res as { ok: boolean; message: string };
    assert.strictEqual(err.ok, false);
    assert.match(err.message, /non-empty title/);
  });

  it("rejects an empty comment body before spending a request", async () => {
    const client = new GitHubClient({ token: "ghp_x" });
    const res = await client.commentOnIssue("acme/repo", 1, "  ");
    const err = res as { ok: boolean; message: string };
    assert.strictEqual(err.ok, false);
    assert.match(err.message, /non-empty body/);
  });

  it("labels credential sources for the operator without revealing them", () => {
    assert.match(connectorSourceLabel("ghp_abc"), /classic PAT/);
    assert.match(connectorSourceLabel(""), /none/);
  });
});
