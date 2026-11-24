import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ConnectorManager,
  connectAppRefusal,
  parseConnectPrompt,
  CONNECT_APP_MARKER,
  isParallelSafeTool,
  registerOrchestratorTools,
} from "../src/index.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";

/**
 * Note on VaultStore isolation: ConnectorManager creates or defaults to a VaultStore
 * located under `path.join(path.dirname(storagePath), "vault")`. In tests, ensure each
 * test suite or test case passes an isolated tmpDir `storagePath` or an explicit isolated
 * `vaultStore` to prevent cross-test vault state leakage.
 */
describe("3rd-Party OAuth Connectors & Connect Cards", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-connectors-test-"));
  const storagePath = path.join(tmpDir, "connectors.json");

  it("initializes with default providers (Slack, Linear, GitHub App)", () => {
    const manager = new ConnectorManager({ storagePath });
    const list = manager.listConnectors();

    assert.strictEqual(list.length, 3);
    const ids = list.map((c) => c.id);
    assert.ok(ids.includes("slack"));
    assert.ok(ids.includes("linear"));
    assert.ok(ids.includes("github"));

    for (const c of list) {
      assert.strictEqual(c.status, "disconnected");
      assert.ok(c.scopes.length > 0);
      assert.ok(c.brandColor.startsWith("#"));
    }
  });

  it("refuses OAuth until a real client ID is configured", async () => {
    const manager = new ConnectorManager({ storagePath });
    await assert.rejects(manager.initiateOAuth("linear"), /OAuth is not configured/);
    assert.strictEqual(manager.getConnector("linear")?.status, "disconnected");
  });

  it("never completes OAuth with a placeholder token or connected state", async () => {
    const oauthStoragePath = path.join(tmpDir, "oauth-configured.json");
    fs.writeFileSync(oauthStoragePath, JSON.stringify([{
      id: "linear",
      status: "disconnected",
      clientId: "configured-linear-client",
      scopes: ["read"],
      authType: "oauth",
      metadata: {},
    }]), { mode: 0o600 });

    const manager = new ConnectorManager({ storagePath: oauthStoragePath });
    const flow = await manager.initiateOAuth("linear");
    assert.strictEqual(flow.providerId, "linear");
    assert.ok(flow.state.length >= 16);
    assert.ok(flow.authUrl.includes("client_id=configured-linear-client"));
    assert.ok(flow.authUrl.includes(`state=${flow.state}`));
    await assert.rejects(
      manager.completeOAuth("linear", "code_12345", flow.state),
      /token exchange is not implemented/,
    );

    const failed = manager.getConnector("linear");
    assert.strictEqual(failed?.status, "error");
    assert.match(failed?.lastError || "", /token exchange is not implemented/);
    assert.strictEqual(manager.getRawCredentials("linear")?.token, undefined);

    const reloaded = new ConnectorManager({ storagePath: oauthStoragePath });
    await reloaded.ensureLoaded();
    assert.strictEqual(reloaded.getConnector("linear")?.status, "error");
    assert.strictEqual(reloaded.getRawCredentials("linear")?.token, undefined);
  });

  it("demotes legacy placeholder OAuth credentials instead of showing them connected", async () => {
    const placeholderPath = path.join(tmpDir, "legacy-placeholder.json");
    const placeholder = "oauth_github_0123456789abcdef01234567";
    fs.writeFileSync(placeholderPath, JSON.stringify([{
      id: "github",
      status: "connected",
      token: placeholder,
      account: "github-org/app",
      connectedAt: "2026-11-13T00:00:00.000Z",
      scopes: ["repo"],
      authType: "oauth",
      metadata: { installedVia: "oauth_flow" },
    }]), { mode: 0o600 });

    const manager = new ConnectorManager({ storagePath: placeholderPath });
    await manager.ensureLoaded();

    const github = manager.getConnector("github");
    assert.strictEqual(github?.status, "disconnected");
    assert.strictEqual(github?.account, undefined);
    assert.match(github?.lastError || "", /was not completed/i);
    assert.strictEqual(manager.getRawCredentials("github")?.token, undefined);
    await assert.rejects(
      manager.configureToken("github", { token: placeholder }),
      /placeholder tokens are not valid/,
    );
    assert.ok(!fs.readFileSync(placeholderPath, "utf8").includes(placeholder));
  });

  it("migrates legacy plaintext tokens in connectors.json to encrypted vault and sanitizes disk file", async () => {
    const migrationStoragePath = path.join(tmpDir, "legacy-connectors.json");
    // Seed an old-format connectors.json containing a plaintext token
    const legacyData = [
      {
        id: "slack",
        status: "connected",
        token: "xoxb-plaintext-legacy-token-12345",
        account: "Legacy Workspace",
        scopes: ["chat:write"],
        authType: "token",
        metadata: {},
      },
    ];
    fs.writeFileSync(migrationStoragePath, JSON.stringify(legacyData, null, 2), { mode: 0o600 });

    const manager = new ConnectorManager({ storagePath: migrationStoragePath });
    await manager.ensureLoaded();

    // 1. In memory, token is preserved and connection verified
    const testRes = await manager.testConnection("slack");
    assert.strictEqual(testRes.ok, false);
    assert.match(testRes.message, /not implemented/i);
    assert.strictEqual(testRes.account, "Legacy Workspace");

    const creds = await manager.getRawCredentialsAsync("slack");
    assert.strictEqual(creds?.token, "xoxb-plaintext-legacy-token-12345");

    // 2. On disk, connectors.json is scrubbed of the plaintext token
    const diskContent = fs.readFileSync(migrationStoragePath, "utf-8");
    assert.ok(!diskContent.includes("xoxb-plaintext-legacy-token-12345"), "Plaintext token must be scrubbed from connectors.json");
    assert.ok(diskContent.includes('"account": "Legacy Workspace"'));

    // 3. New manager reload from the sanitized connectors.json still recovers the vaulted token
    const secondReload = new ConnectorManager({ storagePath: migrationStoragePath });
    await secondReload.ensureLoaded();
    const secondCreds = await secondReload.getRawCredentialsAsync("slack");
    assert.strictEqual(secondCreds?.token, "xoxb-plaintext-legacy-token-12345");
  });

  it("configures manual token credentials directly", async () => {
    const manager = new ConnectorManager({ storagePath });
    const conn = await manager.configureToken("slack", {
      token: "xoxb-1234567890-test-bot-token",
      account: "Acme Slack Workspace",
    });

    assert.strictEqual(conn.status, "connected");
    assert.strictEqual(conn.authType, "token");
    assert.strictEqual(conn.account, "Acme Slack Workspace");

    // Test connection
    const testRes = await manager.testConnection("slack");
    assert.strictEqual(testRes.ok, false);
    assert.match(testRes.message, /not implemented/i);
    assert.strictEqual(testRes.account, "Acme Slack Workspace");

    // Disconnect
    const disconnected = await manager.disconnect("slack");
    assert.strictEqual(disconnected, true);
    assert.strictEqual(manager.getConnector("slack")?.status, "disconnected");
  });

  it("ensureLoaded() is idempotent across sequential and concurrent invocations", async () => {
    const manager = new ConnectorManager({ storagePath });

    // Calling ensureLoaded multiple times concurrently
    await Promise.all([
      manager.ensureLoaded(),
      manager.ensureLoaded(),
      manager.ensureLoaded(),
    ]);

    // Calling ensureLoaded sequentially
    await manager.ensureLoaded();

    // Directly calling an async operation internally ensures loaded without issue.
    const result = await manager.testConnection("github");
    assert.strictEqual(result.ok, false);

    // Calling ensureLoaded again after operations is a safe no-op.
    await manager.ensureLoaded();
    assert.strictEqual(manager.getConnector("github")?.status, "disconnected");
  });

  it("formats and parses [connect-app] markers for inline cards", () => {
    const prompt = {
      serverId: "slack" as const,
      title: "Slack",
      message: "Please connect Slack to post updates to the engineering channel.",
      reason: "connect" as const,
      blocked: true,
    };

    const markerText = connectAppRefusal(prompt);
    assert.ok(markerText.startsWith(CONNECT_APP_MARKER));
    assert.ok(markerText.includes('"serverId":"slack"'));
    assert.ok(markerText.includes('"title":"Slack"'));

    const { prompt: parsed, cleanText } = parseConnectPrompt(markerText);
    assert.ok(parsed !== null);
    assert.strictEqual(parsed?.serverId, "slack");
    assert.strictEqual(parsed?.title, "Slack");
    assert.strictEqual(parsed?.blocked, true);
    assert.ok(cleanText.includes("Please connect Slack"));
  });

  it("evaluates parallel safety for connector tools", () => {
    assert.strictEqual(isParallelSafeTool("show_app_access"), true);
    assert.strictEqual(isParallelSafeTool("list_connectors"), true);
    assert.strictEqual(isParallelSafeTool("slack_post_message"), false);
    assert.strictEqual(isParallelSafeTool("linear_create_issue"), false);
    assert.strictEqual(isParallelSafeTool("github_app_action"), false);
  });

  it("never reports GitHub ready from a stored OAuth placeholder", async () => {
    const placeholderPath = path.join(tmpDir, "placeholder-tool.json");
    fs.writeFileSync(placeholderPath, JSON.stringify([{
      id: "github",
      status: "connected",
      token: "oauth_github_0123456789abcdef01234567",
      account: "github-org/app",
      scopes: ["repo"],
      authType: "oauth",
      metadata: { installedVia: "oauth_flow" },
    }]), { mode: 0o600 });

    const manager = new ConnectorManager({ storagePath: placeholderPath });
    await manager.ensureLoaded();
    assert.strictEqual(manager.getConnector("github")?.status, "disconnected");

    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "placeholder-daemon") });
    try {
      registerOrchestratorTools({
        daemon,
        connectorManager: manager,
        githubClient: { isConnected: () => false } as any,
      });

      const result = await daemon.executeTool("show_app_access", { app_id: "github" });
      assert.ok(typeof result.output === "string");
      assert.ok(result.output.includes(CONNECT_APP_MARKER));
      assert.ok(!result.output.includes('"status":"ready"'));
    } finally {
      fs.rmSync(path.join(tmpDir, "placeholder-daemon"), { recursive: true, force: true });
    }
  });

  it("executes connector tools in orchestrator and handles connect refusals", async () => {
    const manager = new ConnectorManager({ storagePath: path.join(tmpDir, "conn-orch.json") });

    // Stands in for a connected GitHub. The point of these assertions is the
    // wiring: what the client returns is what the tool reports, verbatim.
    let githubConnected = false;
    const fakeGitHub = {
      isConnected: () => githubConnected,
      getViewer: async () => ({ login: "octo-org", id: 1, name: null, scopes: ["repo"] }),
      getRepo: async (repo: string) => ({
        full_name: repo,
        private: false,
        default_branch: "main",
        description: null,
        html_url: `https://github.com/${repo}`,
        pushed_at: null,
        open_issues_count: 0,
      }),
      listIssues: async () => [],
      getPullRequest: async () => {
        throw new Error("not used");
      },
      createIssue: async () => ({ number: 1, html_url: "https://example/1", state: "open" }),
      commentOnIssue: async () => ({ id: 1, html_url: "https://example/c/1" }),
    };

    // Slack and Linear are wired to real clients too, so the test injects fakes
    // rather than relying on a stored token string meaning "connected".
    let slackConnected = false;
    let linearConnected = false;
    const fakeSlack = {
      isConnected: () => slackConnected,
      postMessage: async (channel: string, _text: string) => ({
        ts: "1793852553.000100",
        channel,
      }),
      authTest: async () => ({ team: "Dev Team", team_id: "T1", user: "bot", user_id: "U1" }),
    };
    const fakeLinear = {
      isConnected: () => linearConnected,
      viewer: async () => ({ id: "u1", name: "Dev", email: "dev@example.com" }),
      createIssue: async (input: { title: string; teamKey?: string }) => ({
        id: "issue-1",
        identifier: "ENG-1",
        title: input.title,
        url: "https://linear.app/dev/issue/ENG-1",
      }),
    };
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "daemon-state") });

    registerOrchestratorTools({
      daemon,
      connectorManager: manager,
      githubClient: fakeGitHub,
      slackClient: fakeSlack as never,
      linearClient: fakeLinear as never,
    });

    // 1. show_app_access when disconnected
    const showRes = await daemon.executeTool("show_app_access", { app_id: "github" });
    assert.ok(typeof showRes.output === "string");
    assert.ok(showRes.output.includes(CONNECT_APP_MARKER));
    assert.ok(showRes.output.includes('"serverId":"github"'));

    // 2. slack_post_message when disconnected returns connect card refusal
    const slackRes = await daemon.executeTool("slack_post_message", {
      channel: "#dev-alerts",
      text: "Deployment complete",
    });
    assert.ok(typeof slackRes.output === "string");
    assert.ok(slackRes.output.includes(CONNECT_APP_MARKER));
    assert.ok(slackRes.output.includes('"serverId":"slack"'));

    // 3. With a live client, slack_post_message reports the ts the API returned.
    //    Previously this asserted a ts derived from Date.now().
    slackConnected = true;
    const slackConnectedRes = await daemon.executeTool("slack_post_message", {
      channel: "#dev-alerts",
      text: "Deployment complete",
    });
    const parsedSlack = JSON.parse(slackConnectedRes.output);
    assert.strictEqual(parsedSlack.status, "success");
    assert.strictEqual(parsedSlack.ok, true);
    assert.strictEqual(parsedSlack.channel, "#dev-alerts");
    assert.strictEqual(parsedSlack.ts, "1793852553.000100");

    // 4. linear_create_issue returns the identifier the API assigned.
    //    Previously this asserted an invented one (ENG-<random 100-999>).
    linearConnected = true;
    const linearRes = await daemon.executeTool("linear_create_issue", {
      title: "Investigate telemetry latency",
      team_key: "ENG",
    });
    const parsedLinear = JSON.parse(linearRes.output);
    assert.strictEqual(parsedLinear.status, "success");
    assert.strictEqual(parsedLinear.issue.title, "Investigate telemetry latency");
    assert.strictEqual(parsedLinear.issue.identifier, "ENG-1");

    // 5. With a live client, github_app_action reports what the client returned.
    //    Previously this asserted a fabricated success from a mock token.
    githubConnected = true;
    const githubRes = await daemon.executeTool("github_app_action", {
      action: "get_repo",
      repo: "acme/repo",
    });
    const parsedGithub = JSON.parse(githubRes.output);
    assert.strictEqual(parsedGithub.status, "success");
    assert.strictEqual(parsedGithub.action, "get_repo");
    assert.strictEqual(parsedGithub.repo, "acme/repo");
    assert.strictEqual(parsedGithub.result.full_name, "acme/repo");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
