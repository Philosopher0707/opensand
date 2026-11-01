import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryStore } from "../src/memory-store.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";

describe("MemoryStore - Grok Bot Memory Layers Parity", () => {
  let tmpDir: string;
  let store: MemoryStore;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-memory-test-"));
    store = new MemoryStore({ baseDir: tmpDir });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores and lists discrete facts across scopes and tiers", async () => {
    const f1 = await store.addMemory({
      text: "Prefers TypeScript with strict types and zero any",
      scope: "user",
      tier: "profile",
    });

    const f2 = await store.addMemory({
      text: "[2026-10-31] - Architected OpenSand clean-room agent",
      scope: "user",
      tier: "log",
    });

    const f3 = await store.addMemory({
      text: "CTO persona enforces ADRs for hard-to-reverse decisions",
      scope: "agent",
      agentId: "cto-bot",
      tier: "profile",
    });

    assert.ok(f1.factId.startsWith("fact_"));
    assert.equal(f1.scope, "user");
    assert.equal(f1.tier, "profile");

    // List all
    const all = await store.listMemories({ agentId: "cto-bot" });
    assert.equal(all.length, 3);

    // Filter by tier profile
    const profiles = await store.listMemories({ tier: "profile", agentId: "cto-bot" });
    assert.equal(profiles.length, 2);

    // Filter by query
    const tsMatches = await store.listMemories({ query: "typescript" });
    assert.equal(tsMatches.length, 1);
    assert.equal(tsMatches[0].factId, f1.factId);
  });

  it("forgets facts by factId cleanly", async () => {
    const f = await store.addMemory({
      text: "Temporary fact to forget",
      scope: "user",
      tier: "log",
    });

    const deleted = await store.forgetMemory(f.factId, "user");
    assert.equal(deleted, true);

    const recheck = await store.listMemories({ query: "Temporary fact" });
    assert.equal(recheck.length, 0);
  });

  it("promotes user memories to the team pool (PromoteGrokBotMemoriesToTeam parity)", async () => {
    const f1 = await store.addMemory({
      text: "Monorepo uses pnpm workspaces and tsc -b",
      scope: "user",
      tier: "profile",
    });

    const f2 = await store.addMemory({
      text: "Desktop daemon communicates over SSE on port 3456",
      scope: "user",
      tier: "log",
    });

    const promoRes = await store.promoteMemoriesToTeam("cto-bot", [f1.factId, f2.factId]);
    assert.equal(promoRes.created.length, 2);
    assert.equal(promoRes.alreadyInTeam.length, 0);

    // Verify facts exist in team scope
    const teamFacts = await store.listMemories({ scope: "team" });
    assert.equal(teamFacts.length, 2);

    // Promoting again detects duplicates
    const promoAgain = await store.promoteMemoriesToTeam("cto-bot", [f1.factId]);
    assert.equal(promoAgain.created.length, 0);
    assert.equal(promoAgain.alreadyInTeam.length, 1);
  });

  it("manages team context summary with prose synthesis", async () => {
    const summary = await store.getTeamContextSummary();
    assert.ok(summary.memoryCount >= 2);
    assert.ok(summary.prose.length > 0);

    await store.updateTeamContextSummary("The team builds high-rigor coding agents with zero collateral edits.");
    const updated = await store.getTeamContextSummary();
    assert.equal(updated.prose, "The team builds high-rigor coding agents with zero collateral edits.");
    assert.ok(updated.memoryVersion > 1);
  });

  it("handles team consensus review queue (GrokBotTeamReviewItem parity)", async () => {
    // 1. Propose writing a team memory
    const item = await store.addReviewItem({
      proposedBy: "agent-cto",
      change: {
        action: "write",
        memoryType: "profile",
        text: "Always run pnpm test before committing changes",
      },
    });

    assert.ok(item.itemId.startsWith("rev_"));
    assert.equal(item.status, "pending");

    // 2. List review items
    const pendingList = await store.listReviewItems({ status: "pending" });
    assert.ok(pendingList.some((i) => i.itemId === item.itemId));

    // 3. Resolve with approval -> automatically commits to team memory
    const resolved = await store.resolveReviewItem(item.itemId, "approve", "lead_engineer");
    assert.equal(resolved.status, "approved");
    assert.equal(resolved.reviewedBy, "lead_engineer");

    const teamFacts = await store.listMemories({ scope: "team", query: "pnpm test before committing" });
    assert.equal(teamFacts.length, 1);

    // 4. Propose forgetting a team memory and resolve
    const forgetProposal = await store.addReviewItem({
      proposedBy: "developer",
      change: {
        action: "forget",
        memoryType: "profile",
        text: "Always run pnpm test before committing changes",
      },
    });

    await store.resolveReviewItem(forgetProposal.itemId, "approve", "lead_engineer");
    const recheck = await store.listMemories({ scope: "team", query: "pnpm test before committing" });
    assert.equal(recheck.length, 0);
  });

  it("imports memories with <imported_memory> protocol and secret filtering", async () => {
    const sampleExport = `
## 1. Instructions
[2026-03-01] - Always format code changes as minimal unified diffs
- Never touch package-lock.json or lockfiles without permission

## 2. Identity
[unknown] - Principal software architect and systems engineer

## 3. Projects
[2026-10-28] - OpenSand universal coding agent with Grok Bot parity

## Filtered Secrets
- OpenAI key is sk-1234567890abcdef1234567890
- AWS secret AKIAIOSFODNN7EXAMPLE
`;

    const result = await store.importMemoryText(sampleExport, "user");
    assert.equal(result.savedCount, 4);
    assert.equal(result.skippedCount, 2); // 2 secrets filtered out!

    const imported = await store.listMemories({ scope: "user" });
    assert.ok(imported.some((m) => m.text.includes("minimal unified diffs") && m.tier === "profile"));
    assert.ok(imported.some((m) => m.text.includes("OpenSand universal coding agent") && m.tier === "log"));
  });

  it("formats prompt memory context accurately", async () => {
    const promptContext = await store.getPromptMemoryContext("cto-bot");
    assert.ok(promptContext.includes("### User Profile & Preferences"));
    assert.ok(promptContext.includes("### Agent Persona Guidelines"));
    assert.ok(promptContext.includes("### Shared Team Context"));
  });

  it("dispatches memory tools through LocalExecDaemon", async () => {
    const daemon = new LocalExecDaemon({ stateDir: path.join(tmpDir, "state") });
    registerOrchestratorTools({
      daemon,
      memoryStore: store,
    });

    // Test update_memory tool
    const writeRes = await daemon.executeTool("update_memory", {
      action: "write",
      text: "Daemon dispatched memory fact test",
      scope: "user",
      tier: "log",
    });
    assert.equal(writeRes.status, "ok");
    const parsedWrite = JSON.parse(writeRes.output);
    assert.equal(parsedWrite.status, "success");
    assert.ok(parsedWrite.fact.factId);

    // Test recall_memories tool
    const recallRes = await daemon.executeTool("recall_memories", {
      query: "Daemon dispatched",
    });
    assert.equal(recallRes.status, "ok");
    const parsedRecall = JSON.parse(recallRes.output);
    assert.equal(parsedRecall.totalMemories, 1);

    // Test import_memory tool
    const importRes = await daemon.executeTool("import_memory", {
      text: `## 1. Instructions\n- Tool dispatched import instruction`,
    });
    assert.equal(importRes.status, "ok");
    const parsedImport = JSON.parse(importRes.output);
    assert.equal(parsedImport.status, "success");
    assert.equal(parsedImport.savedCount, 1);
  });
});
