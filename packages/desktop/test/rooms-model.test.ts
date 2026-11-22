import test from "node:test";
import assert from "node:assert";
import {
  validateCreateRoomInput,
  formatRoomCard,
  createInitialModalState,
  openCreateRoomModal,
  closeCreateRoomModal,
  openConveneModal,
  closeConveneModal,
  appendTurns,
  formatConsensus,
  type Room,
  type DiscussionTurn,
  type DiscussionResult,
} from "../src/shell/rooms-model.js";

const room: Room = {
  roomId: "room_1",
  name: "Architecture Review Board",
  description: "Reviews high-impact changes",
  memberAgentIds: ["a1", "a2", "a3"],
  discussionCount: 2,
  activeTopic: "Migrate the database layer to edge replication across regions",
};

test("rooms-model: validateCreateRoomInput requires a name and a member", () => {
  assert.strictEqual(validateCreateRoomInput({ name: "", description: "", memberAgentIds: ["a1"] }),
    "Please provide a room name and select at least one member agent.");
  assert.strictEqual(validateCreateRoomInput({ name: "   ", description: "", memberAgentIds: ["a1"] }) !== null, true);
  assert.strictEqual(validateCreateRoomInput({ name: "Board", description: "", memberAgentIds: [] }) !== null, true);
  assert.strictEqual(validateCreateRoomInput({ name: "Board", description: "", memberAgentIds: ["a1"] }), null);
});

test("rooms-model: formatRoomCard formats badges, fallback description and topic preview", () => {
  const card = formatRoomCard(room);
  assert.strictEqual(card.title, "Architecture Review Board");
  assert.strictEqual(card.memberLabel, "3 Agents");
  assert.strictEqual(card.description, "Reviews high-impact changes");
  assert.strictEqual(card.discussionLabel, "Discussions: 2");
  assert.ok(card.activeTopicLabel?.startsWith("Active Topic: "));
  assert.ok(card.activeTopicLabel?.endsWith("..."));
  assert.strictEqual(card.activeTopicLabel, `Active Topic: ${room.activeTopic!.slice(0, 28)}...`);
  assert.strictEqual(card.activeTopicTitle, room.activeTopic);

  const bare = formatRoomCard({ roomId: "r", name: "", description: "", memberAgentIds: [], discussionCount: 0 } as Room);
  assert.strictEqual(bare.title, "Untitled room");
  assert.strictEqual(bare.description, "No description.");
  assert.strictEqual(bare.discussionLabel, "Discussions: 0");
  assert.strictEqual(bare.activeTopicLabel, null);
  assert.strictEqual(bare.activeTopicTitle, null);
});

test("rooms-model: modal state opens and closes each modal independently", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { createRoomModalOpen: false, conveneModalOpen: false, activeRoomId: null });

  const createOpen = openCreateRoomModal(initial);
  assert.strictEqual(createOpen.createRoomModalOpen, true);
  assert.strictEqual(createOpen.conveneModalOpen, false);
  assert.strictEqual(closeCreateRoomModal(createOpen).createRoomModalOpen, false);

  const conveneOpen = openConveneModal(initial, "room_1");
  assert.strictEqual(conveneOpen.conveneModalOpen, true);
  assert.strictEqual(conveneOpen.activeRoomId, "room_1");
  assert.deepStrictEqual(closeConveneModal(conveneOpen), initial);
});

test("rooms-model: appendTurns accumulates turns and tolerates missing input", () => {
  const first: DiscussionTurn = { turnIndex: 1, memberName: "Ada", memberRole: "Architect", content: "First" };
  const second: DiscussionTurn = { turnIndex: 2, memberName: "Dex", memberRole: "Engineer", content: "Second" };
  assert.deepStrictEqual(appendTurns([], [first, second]), [first, second]);
  assert.deepStrictEqual(appendTurns([first], [second]), [first, second]);
  assert.deepStrictEqual(appendTurns([first], undefined), [first]);
});

test("rooms-model: formatConsensus falls back when consensus is missing", () => {
  const result: DiscussionResult = { roomId: "room_1", consensus: "Adopt the migration.", turns: [] };
  assert.strictEqual(formatConsensus(result), "Adopt the migration.");
  assert.strictEqual(formatConsensus({ roomId: "room_1", consensus: "   ", turns: [] }), "No consensus rendered.");
});
