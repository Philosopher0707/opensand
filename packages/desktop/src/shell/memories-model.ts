// Pure model for the 7-Layer Memory & Team Review Queue view (Phase 5 Row 17).
// Mirrors the legacy renderer/app.js memory controller without DOM or bridge code.

export const MEMORY_SCOPES = ["user", "agent", "team"] as const;
export type MemoryScope = typeof MEMORY_SCOPES[number];

export const MEMORY_TIERS = ["preference", "profile", "guideline", "rule"] as const;
export type MemoryTier = typeof MEMORY_TIERS[number];

export interface MemoryFact {
  id: string;
  text: string;
  scope: MemoryScope | string;
  tier: MemoryTier | string;
  agentId?: string;
  confidence?: number;
  updatedAtMs?: number;
  createdAtMs?: number;
  [key: string]: unknown;
}

export interface ReviewItem {
  id: string;
  action: string;
  status: string;
  proposedByAgentId: string;
  proposedFact: {
    text: string;
    tier: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreateMemoryInput {
  text: string;
  scope: MemoryScope | string;
  tier: MemoryTier | string;
  agentId?: string;
}

export interface ReviewCardView {
  title: string;
  status: string;
  text: string;
  proposedBy: string;
  tier: string;
}

export interface MemoryCardView {
  tierTitle: string;
  scopeBadge: string;
  text: string;
  confidenceLabel: string;
  dateLabel: string;
}

export interface MemoriesModalState {
  addMemoryModalOpen: boolean;
}

export const MEMORY_VALIDATION_MESSAGE = "Please provide memory text.";
export const TEAM_REVIEW_EMPTY_STATE = "No pending team memory review proposals.";
export const MEMORIES_EMPTY_STATE = "No memory facts recorded yet.";

export function validateMemoryInput(input: CreateMemoryInput): string | null {
  if (!input.text?.trim()) {
    return MEMORY_VALIDATION_MESSAGE;
  }
  if (!MEMORY_SCOPES.includes(input.scope as MemoryScope)) {
    return "Please select a valid memory scope.";
  }
  if (!MEMORY_TIERS.includes(input.tier as MemoryTier)) {
    return "Please select a valid memory tier.";
  }
  return null;
}

export function reviewCardView(item: ReviewItem): ReviewCardView {
  const rawText = item.proposedFact?.text || "";
  const action = item.action || "proposal";
  const title = `${action}: ${rawText.slice(0, 40)}${rawText.length > 40 ? "..." : ""}`;
  return {
    title,
    status: item.status || "pending",
    text: rawText,
    proposedBy: item.proposedByAgentId || "unknown",
    tier: item.proposedFact?.tier || "rule",
  };
}

export function memoryCardView(fact: MemoryFact): MemoryCardView {
  const tierTitle = (fact.tier || "fact").toUpperCase();
  const scopeBadge = fact.scope || "user";
  const confidencePct = Math.round((typeof fact.confidence === "number" ? fact.confidence : 1) * 100);
  const dateMs = fact.updatedAtMs || fact.createdAtMs || Date.now();
  const dateLabel = new Date(dateMs).toLocaleDateString();
  return {
    tierTitle,
    scopeBadge,
    text: fact.text || "",
    confidenceLabel: `Confidence: ${confidencePct}%`,
    dateLabel,
  };
}

export function createInitialModalState(): MemoriesModalState {
  return { addMemoryModalOpen: false };
}

export function openAddMemoryModal(state: MemoriesModalState): MemoriesModalState {
  return { ...state, addMemoryModalOpen: true };
}

export function closeAddMemoryModal(state: MemoriesModalState): MemoriesModalState {
  return { ...state, addMemoryModalOpen: false };
}
