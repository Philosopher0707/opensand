import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { RoomManager, CreateRoomInput } from "../src/room-manager.js";
import { AgentStore } from "../src/agent-store.js";
import { VaultStore } from "../src/vault-store.js";

describe("RoomManager", () => {
  let tempRoomsDir: string;
  let tempAgentsDir: string;
  let tempVaultDir: string;
  let roomManager: RoomManager;
  let agentStore: AgentStore;
  let vaultStore: VaultStore;

  beforeEach(async () => {
    tempRoomsDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-rooms-test-"));
    tempAgentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-agents-test-"));
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-vault-test-"));

    agentStore = new AgentStore(tempAgentsDir);
    vaultStore = new VaultStore({ baseDir: tempVaultDir });
    roomManager = new RoomManager(tempRoomsDir, agentStore, vaultStore);
  });

  afterEach(async () => {
    await fs.rm(tempRoomsDir, { recursive: true, force: true });
    await fs.rm(tempAgentsDir, { recursive: true, force: true });
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  describe("Room CRUD & Membership", () => {
    it("creates, retrieves, and lists rooms", async () => {
      // Create sample agents in AgentStore
      const agent1 = await agentStore.createAgent({
        name: "Security Lead",
        role: "AppSec Reviewer",
        systemPrompt: "Audit code for security vulnerabilities",
      });

      const agent2 = await agentStore.createAgent({
        name: "Database Architect",
        role: "Data Systems Specialist",
        systemPrompt: "Verify migrations and data consistency",
      });

      const room = await roomManager.createRoom({
        name: "Architecture Review Board",
        description: "Evaluates high-impact system architecture changes",
        memberAgentIds: [agent1.id, agent2.id],
      });

      assert.ok(room.roomId.startsWith("room_"));
      assert.strictEqual(room.name, "Architecture Review Board");
      assert.strictEqual(room.kind, "ROOM");
      assert.strictEqual(room.memberAgentIds.length, 2);

      const retrieved = await roomManager.getRoom(room.roomId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved?.name, "Architecture Review Board");

      const all = await roomManager.listRooms();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0].roomId, room.roomId);
    });

    it("updates room members dynamically", async () => {
      const room = await roomManager.createRoom({
        name: "Sprint Triage Room",
        description: "Triages daily bugs",
        memberAgentIds: ["agent_coder"],
      });

      assert.strictEqual(room.memberAgentIds.length, 1);

      const updated = await roomManager.setRoomMembers(room.roomId, [
        "agent_coder",
        "agent_tester",
        "agent_reviewer",
      ]);

      assert.strictEqual(updated.memberAgentIds.length, 3);
      assert.deepStrictEqual(updated.memberAgentIds, [
        "agent_coder",
        "agent_tester",
        "agent_reviewer",
      ]);

      const fresh = await roomManager.getRoom(room.roomId);
      assert.strictEqual(fresh?.memberAgentIds.length, 3);
    });

    it("deletes rooms cleanly and removes mirrored agent", async () => {
      const room = await roomManager.createRoom({
        name: "Temporary Team",
        description: "Ad-hoc working group",
        memberAgentIds: ["agent_temp"],
      });

      const agentsBefore = await agentStore.listAgents();
      const mirroredAgent = agentsBefore.find(
        (a) => a.kind === "ROOM" && a.metadata?.roomId === room.roomId
      );
      assert.ok(mirroredAgent, "Mirrored agent should exist after room creation");

      const deleted = await roomManager.deleteRoom(room.roomId);
      assert.strictEqual(deleted, true);

      const found = await roomManager.getRoom(room.roomId);
      assert.strictEqual(found, null);

      const agentsAfter = await agentStore.listAgents();
      const mirroredAfter = agentsAfter.find(
        (a) => a.kind === "ROOM" && a.metadata?.roomId === room.roomId
      );
      assert.strictEqual(mirroredAfter, undefined, "Mirrored agent should be removed on room deletion");
    });
  });

  describe("Room Multi-Agent Discussions & Consensus Synthesis", () => {
    it("conducts round-table discussion and synthesizes meeting draft with vault redaction", async () => {
      // Store a secret in the vault
      await vaultStore.putSecret({
        name: "API_SECRET_TOKEN",
        value: "ghp_secure_super_token_999",
      });

      // Create two agents
      const agentSec = await agentStore.createAgent({
        name: "Security Sentinel",
        role: "SecOps",
        systemPrompt: "Verify auth safety",
      });

      const agentArch = await agentStore.createAgent({
        name: "Chief Architect",
        role: "Architecture",
        systemPrompt: "Verify system boundaries",
      });

      const room = await roomManager.createRoom({
        name: "Core Infrastructure Board",
        description: "Reviews infrastructure updates",
        memberAgentIds: [agentSec.id, agentArch.id],
      });

      // Provide custom executor that simulates collaborative multi-agent discussion
      const discussion = await roomManager.runRoomDiscussion(
        room.roomId,
        "Upgrade Authentication Gateway to v2",
        async (member, topic, turnIndex, previousTurns) => {
          if (member.name === "Security Sentinel") {
            return {
              status: "success",
              content: `Examined secret token usage ghp_secure_super_token_999. Invariant: token must stay isolated in VaultStore.`,
            };
          } else {
            // Second agent observes turn 1
            assert.strictEqual(previousTurns.length, 1);
            return {
              status: "success",
              content: `Agreed with ${previousTurns[0].memberName}. Gateway upgrade approved with safe vault boundary.`,
            };
          }
        }
      );

      assert.ok(discussion.discussionId.startsWith("disc_"));
      assert.strictEqual(discussion.turns.length, 2);
      assert.strictEqual(discussion.turns[0].memberName, "Security Sentinel");
      assert.strictEqual(discussion.turns[1].memberName, "Chief Architect");

      // Verify that the secret was scrubbed via VaultStore in turn content and consensus
      assert.ok(
        discussion.turns[0].content.includes("[REDACTED_VAULT_SECRET:API_SECRET_TOKEN]")
      );
      assert.ok(!discussion.turns[0].content.includes("ghp_secure_super_token_999"));

      // Verify consensus agreement structure
      assert.ok(discussion.consensus.includes("# Meeting Consensus Agreement"));
      assert.ok(discussion.consensus.includes("Upgrade Authentication Gateway to v2"));
      assert.ok(discussion.consensus.includes("CONSENSUS_APPROVED"));

      // Verify discussion retrieval and room counters
      const loaded = await roomManager.getDiscussion(discussion.discussionId);
      assert.ok(loaded);
      assert.strictEqual(loaded?.discussionId, discussion.discussionId);

      const roomDiscussions = await roomManager.listRoomDiscussions(room.roomId);
      assert.strictEqual(roomDiscussions.length, 1);

      const updatedRoom = await roomManager.getRoom(room.roomId);
      assert.strictEqual(updatedRoom?.discussionCount, 1);
      assert.strictEqual(updatedRoom?.activeTopic, "Upgrade Authentication Gateway to v2");
    });
  });
});
