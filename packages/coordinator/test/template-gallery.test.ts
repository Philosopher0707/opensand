import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentStore } from "../src/agent-store.js";
import { TemplateGallery } from "../src/template-gallery.js";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";

test("TemplateGallery - loads curated templates with defaults and categories", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-test-"));

  try {
    const store = new AgentStore(tmpDir);
    const gallery = new TemplateGallery({
      storagePath: path.join(tmpDir, "gallery.json"),
      agentStore: store,
    });

    const templates = await gallery.listTemplates();
    assert.strictEqual(templates.length, 8);

    const categories = new Set(templates.map((t) => t.category));
    assert.ok(categories.has("engineering"));
    assert.ok(categories.has("security"));
    assert.ok(categories.has("product"));
    assert.ok(categories.has("research"));

    templates.forEach((t) => {
      assert.strictEqual(t.isCommunity, false);
      assert.ok(t.downloads > 0);
      assert.ok(t.stars >= 100);
      assert.ok(t.tags.length > 0);
    });

    const reviewer = gallery.getTemplate("code-reviewer");
    assert.ok(reviewer);
    assert.strictEqual(reviewer?.name, "Code Reviewer & PR Auditor");
    assert.strictEqual(reviewer?.role, "Lead Code Reviewer & Quality Gatekeeper");
    assert.ok(reviewer?.allowedTools.includes("read_file"));
    assert.ok(reviewer?.starterTasks && reviewer.starterTasks.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TemplateGallery - category and keyword filtering", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-filter-"));

  try {
    const store = new AgentStore(tmpDir);
    const gallery = new TemplateGallery({
      storagePath: path.join(tmpDir, "gallery.json"),
      agentStore: store,
    });

    // Filter by category
    const secTemplates = await gallery.listTemplates({ category: "security" });
    assert.ok(secTemplates.length >= 2);
    secTemplates.forEach((t) => assert.strictEqual(t.category, "security"));

    // Search by query
    const refactorQuery = await gallery.listTemplates({ query: "refactor" });
    assert.strictEqual(refactorQuery.length, 1);
    assert.strictEqual(refactorQuery[0].id, "refactoring-architect");

    // Search by tag
    const slackTag = await gallery.listTemplates({ tag: "slack" });
    assert.strictEqual(slackTag.length, 1);
    assert.strictEqual(slackTag[0].id, "slack-scout");

    // Non-matching query
    const none = await gallery.listTemplates({ query: "nonexistent-quantum-widget" });
    assert.strictEqual(none.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TemplateGallery - template installation into AgentStore", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-install-"));

  try {
    const store = new AgentStore(tmpDir);
    const gallery = new TemplateGallery({
      storagePath: path.join(tmpDir, "gallery.json"),
      agentStore: store,
    });

    // Initially uninstalled
    const initialList = await gallery.listTemplates();
    const target = initialList.find((t) => t.id === "code-reviewer");
    assert.strictEqual(target?.installed, false);

    // Install template
    const installRes = await gallery.installTemplate("code-reviewer");
    assert.ok(installRes.agent);
    assert.strictEqual(installRes.agent.name, "Code Reviewer & PR Auditor");
    assert.strictEqual(installRes.agent.role, "Lead Code Reviewer & Quality Gatekeeper");
    assert.ok(installRes.agent.allowedTools?.includes("read_file"));

    // Verify presence in AgentStore
    const localAgents = await store.listAgents();
    assert.strictEqual(localAgents.length, 1);
    assert.strictEqual(localAgents[0].name, "Code Reviewer & PR Auditor");

    // Verify installed flag is now true
    const updatedList = await gallery.listTemplates();
    const updatedTarget = updatedList.find((t) => t.id === "code-reviewer");
    assert.strictEqual(updatedTarget?.installed, true);

    // Non-existent template throws error
    await assert.rejects(
      async () => gallery.installTemplate("bogus-bot-404"),
      /not found/i
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TemplateGallery - community template publishing, persistence, and deletion", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-pub-"));

  try {
    const store = new AgentStore(tmpDir);
    const storagePath = path.join(tmpDir, "gallery.json");
    const gallery = new TemplateGallery({ storagePath, agentStore: store });

    // 1. Publish new community template
    const published = await gallery.publishTemplate({
      id: "fastapi-expert",
      name: "FastAPI Expert",
      role: "Backend Python Engineer",
      description: "Write robust async FastAPI endpoints with Pydantic v2 schemas.",
      systemPrompt: "Write robust async FastAPI endpoints with Pydantic v2 schemas.",
      allowedTools: ["exec_command", "read_file", "write_file"],
      category: "engineering",
      author: "python_guru",
      version: "1.0.0",
      icon: "⚡",
      recommendedModel: "anthropic/claude-sonnet",
      tags: ["python", "fastapi", "rest"],
    });

    assert.strictEqual(published.id, "fastapi-expert");
    assert.strictEqual(published.name, "FastAPI Expert");
    assert.strictEqual(published.isCommunity, true);
    assert.strictEqual(published.author, "python_guru");

    // 2. Verify persistence across instances
    const gallery2 = new TemplateGallery({ storagePath, agentStore: store });
    const all = await gallery2.listTemplates();
    assert.strictEqual(all.length, 9); // 8 curated + 1 community
    const retrieved = gallery2.getTemplate("fastapi-expert");
    assert.ok(retrieved);
    assert.strictEqual(retrieved?.name, "FastAPI Expert");

    // 3. Deleting curated template returns false
    const delCurated = await gallery2.deleteTemplate("code-reviewer");
    assert.strictEqual(delCurated, false);

    // 4. Deleting community template should succeed
    const deleted = await gallery2.deleteTemplate("fastapi-expert");
    assert.strictEqual(deleted, true);

    const afterDelete = await gallery2.listTemplates();
    assert.strictEqual(afterDelete.length, 8);
    const checkDeleted = gallery2.getTemplate("fastapi-expert");
    assert.strictEqual(checkDeleted, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OrchestratorTools - list_gallery_templates and install_gallery_template tools", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-gallery-tools-"));

  try {
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    await daemon.start();
    await daemon.state.writePermissionGates({ computerUseAllowed: true });

    const store = new AgentStore(path.join(tmpDir, "agents"));
    const gallery = new TemplateGallery({
      storagePath: path.join(tmpDir, "gallery.json"),
      agentStore: store,
    });

    registerOrchestratorTools({
      daemon,
      store,
      templateGallery: gallery,
      sessionsBaseDir: path.join(tmpDir, "sessions"),
    });

    // 1. Tool definitions registered
    const defs = daemon.getToolDefinitions();
    const toolNames = defs.map((d) => d.function.name);
    assert.ok(toolNames.includes("list_gallery_templates"));
    assert.ok(toolNames.includes("install_gallery_template"));

    // 2. Execute list_gallery_templates
    const listRes = await daemon.executeTool("list_gallery_templates", { category: "security" });
    assert.strictEqual(listRes.status, "ok");
    const parsedList = JSON.parse(listRes.output);
    assert.strictEqual(parsedList.status, "success");
    assert.ok(Array.isArray(parsedList.templates));
    assert.ok(parsedList.templates.length >= 2);

    // 3. Execute install_gallery_template
    const installRes = await daemon.executeTool("install_gallery_template", {
      template_id: "security-auditor",
    });
    assert.strictEqual(installRes.status, "ok");
    const parsedInstall = JSON.parse(installRes.output);
    assert.strictEqual(parsedInstall.status, "success");
    assert.strictEqual(parsedInstall.agent.name, "Security Vulnerability Auditor");

    // 4. Verify agent exists in store
    const agents = await store.listAgents();
    assert.strictEqual(agents.length, 1);
    assert.strictEqual(agents[0].name, "Security Vulnerability Auditor");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
