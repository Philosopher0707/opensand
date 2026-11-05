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

describe("3rd-Party OAuth Connectors & Connect Cards", () => {
  const tmpDir = path.join(os.tmpdir(), `opensand-connectors-test-${Date.now()}`);
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

  it("initiates OAuth flow with proper scopes, client_id, and state", () => {
    const manager = new ConnectorManager({ storagePath });
    const flow = manager.initiateOAuth("slack", "http://127.0.0.1:3456/api/connectors/callback");

    assert.strictEqual(flow.providerId, "slack");
    assert.ok(flow.state.length >= 16);
    assert.ok(flow.authUrl.startsWith("https://slack.com/oauth/v2/authorize"));
    assert.ok(flow.authUrl.includes("client_id="));
    assert.ok(flow.authUrl.includes("scope=chat%3Awrite"));
    assert.ok(flow.authUrl.includes(`state=${flow.state}`));

    // Connector is marked as connecting
    const conn = manager.getConnector("slack");
    assert.strictEqual(conn?.status, "connecting");
  });

  it("completes OAuth flow and stores connected state", async () => {
    const manager = new ConnectorManager({ storagePath });
    const flow = manager.initiateOAuth("linear");
    const completed = await manager.completeOAuth("linear", "code_12345", flow.state);

    assert.strictEqual(completed.status, "connected");
    assert.strictEqual(completed.id, "linear");
    assert.strictEqual(completed.authType, "oauth");
    assert.ok(completed.account);
    assert.ok(completed.connectedAt);

    // Verify persistence
    const reloaded = new ConnectorManager({ storagePath });
    const reloadedLinear = reloaded.getConnector("linear");
    assert.strictEqual(reloadedLinear?.status, "connected");
    assert.strictEqual(reloadedLinear?.account, completed.account);
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
    assert.strictEqual(testRes.ok, true);
    assert.strictEqual(testRes.account, "Acme Slack Workspace");

    // Disconnect
    const disconnected = await manager.disconnect("slack");
    assert.strictEqual(disconnected, true);
    assert.strictEqual(manager.getConnector("slack")?.status, "disconnected");
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

  it("executes connector tools in orchestrator and handles connect refusals", async () => {
    const manager = new ConnectorManager({ storagePath: path.join(tmpDir, "conn-orch.json") });
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "daemon-state") });

    registerOrchestratorTools({
      daemon,
      connectorManager: manager,
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

    // 3. Connect Slack via token and re-execute
    await manager.configureToken("slack", {
      token: "xoxb-mock-token",
      account: "Dev Team",
    });

    const slackConnectedRes = await daemon.executeTool("slack_post_message", {
      channel: "#dev-alerts",
      text: "Deployment complete",
    });
    const parsedSlack = JSON.parse(slackConnectedRes.output);
    assert.strictEqual(parsedSlack.status, "success");
    assert.strictEqual(parsedSlack.ok, true);
    assert.strictEqual(parsedSlack.channel, "#dev-alerts");

    // 4. Connect Linear via token and create issue
    await manager.configureToken("linear", {
      token: "lin_api_mock",
      account: "Linear Workspace",
    });
    const linearRes = await daemon.executeTool("linear_create_issue", {
      title: "Investigate telemetry latency",
      team_key: "ENG",
    });
    const parsedLinear = JSON.parse(linearRes.output);
    assert.strictEqual(parsedLinear.status, "success");
    assert.strictEqual(parsedLinear.issue.title, "Investigate telemetry latency");
    assert.strictEqual(parsedLinear.issue.team, "ENG");

    // 5. Connect GitHub App via token and perform action
    await manager.configureToken("github", {
      token: "ghp_mock",
      account: "octo-org",
    });
    const githubRes = await daemon.executeTool("github_app_action", {
      action: "create_issue",
      repo: "acme/repo",
      title: "Bug in auth flow",
    });
    const parsedGithub = JSON.parse(githubRes.output);
    assert.strictEqual(parsedGithub.status, "success");
    assert.strictEqual(parsedGithub.action, "create_issue");
    assert.strictEqual(parsedGithub.repo, "acme/repo");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
