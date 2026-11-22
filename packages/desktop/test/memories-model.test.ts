import test from "node:test";
import assert from "node:assert";
import {
  MEMORY_VALIDATION_MESSAGE,
  TEAM_REVIEW_EMPTY_STATE,
  MEMORIES_EMPTY_STATE,
  MEMORY_SCOPES,
  MEMORY_TIERS,
  validateMemoryInput,
  reviewCardView,
  memoryCardView,
  createInitialModalState,
  openAddMemoryModal,
  closeAddMemoryModal,
  type MemoryFact,
  type ReviewItem,
  type CreateMemoryInput,
} from "../src/shell/memories-model.js";

const valid: CreateMemoryInput = {
  text: "Always format commit messages with conventional commits",
  scope: "team",
  tier: "guideline",
};

test("memories-model: validation requires non-empty text", () => {
  assert.strictEqual(validateMemoryInput(valid), null);
  assert.strictEqual(validateMemoryInput({ ...valid, text: "" }), MEMORY_VALIDATION_MESSAGE);
  assert.strictEqual(validateMemoryInput({ ...valid, text: "   " }), MEMORY_VALIDATION_MESSAGE);
  assert.strictEqual(validateMemoryInput({ ...valid, text: "\t\n  " }), MEMORY_VALIDATION_MESSAGE);
});

test("memories-model: validation restricts scope and tier to select options", () => {
  assert.strictEqual(validateMemoryInput({ ...valid, scope: "invalid_scope" as any }), "Please select a valid memory scope.");
  assert.strictEqual(validateMemoryInput({ ...valid, tier: "invalid_tier" as any }), "Please select a valid memory tier.");

  for (const scope of MEMORY_SCOPES) {
    assert.strictEqual(validateMemoryInput({ ...valid, scope }), null);
  }
  for (const tier of MEMORY_TIERS) {
    assert.strictEqual(validateMemoryInput({ ...valid, tier }), null);
  }
});

test("memories-model: reviewCardView formats title with action and ellipsis only if >40 chars", () => {
  const shortItem: ReviewItem = {
    id: "rev-1",
    action: "create",
    status: "pending",
    proposedByAgentId: "agent-alpha",
    proposedFact: {
      text: "Short text under 40",
      tier: "rule",
    },
  };
  const shortView = reviewCardView(shortItem);
  assert.strictEqual(shortView.title, "create: Short text under 40");
  assert.strictEqual(shortView.status, "pending");
  assert.strictEqual(shortView.proposedBy, "agent-alpha");
  assert.strictEqual(shortView.tier, "rule");

  const exact40Text = "1234567890123456789012345678901234567890"; // exactly 40 chars
  assert.strictEqual(exact40Text.length, 40);
  const exactItem: ReviewItem = {
    id: "rev-2",
    action: "update",
    status: "pending",
    proposedByAgentId: "agent-beta",
    proposedFact: {
      text: exact40Text,
      tier: "preference",
    },
  };
  const exactView = reviewCardView(exactItem);
  assert.strictEqual(exactView.title, `update: ${exact40Text}`);

  const longText = "1234567890123456789012345678901234567890X extra trailing characters";
  const longItem: ReviewItem = {
    id: "rev-3",
    action: "promote",
    status: "pending",
    proposedByAgentId: "agent-gamma",
    proposedFact: {
      text: longText,
      tier: "guideline",
    },
  };
  const longView = reviewCardView(longItem);
  assert.strictEqual(longView.title, `promote: ${exact40Text}...`);
  assert.strictEqual(longView.text, longText);
});

test("memories-model: memoryCardView defaults and formatting", () => {
  const fact: MemoryFact = {
    id: "fact-1",
    text: "Never touch production directly",
    scope: "agent",
    tier: "rule",
    confidence: 0.95,
    updatedAtMs: 1700000000000,
  };
  const card = memoryCardView(fact);
  assert.strictEqual(card.tierTitle, "RULE");
  assert.strictEqual(card.scopeBadge, "agent");
  assert.strictEqual(card.text, "Never touch production directly");
  assert.strictEqual(card.confidenceLabel, "Confidence: 95%");
  assert.strictEqual(card.dateLabel, new Date(1700000000000).toLocaleDateString());

  // Defaults test
  const defaultFact: MemoryFact = {
    id: "fact-2",
    text: "Default scope and tier",
    scope: "",
    tier: "",
  };
  const defaultCard = memoryCardView(defaultFact);
  assert.strictEqual(defaultCard.tierTitle, "FACT");
  assert.strictEqual(defaultCard.scopeBadge, "user");
  assert.strictEqual(defaultCard.confidenceLabel, "Confidence: 100%");
});

test("memories-model: modal open/close helpers", () => {
  const initial = createInitialModalState();
  assert.strictEqual(initial.addMemoryModalOpen, false);

  const opened = openAddMemoryModal(initial);
  assert.strictEqual(opened.addMemoryModalOpen, true);

  const closed = closeAddMemoryModal(opened);
  assert.strictEqual(closed.addMemoryModalOpen, false);
});

test("memories-model: empty state constants match legacy strings", () => {
  assert.strictEqual(TEAM_REVIEW_EMPTY_STATE, "No pending team memory review proposals.");
  assert.strictEqual(MEMORIES_EMPTY_STATE, "No memory facts recorded yet.");
});
