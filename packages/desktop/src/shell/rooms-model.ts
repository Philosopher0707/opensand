// Pure model for the Multi-Agent Collaborative Rooms view (Phase 5 Row 13).
// Mirrors the legacy renderer/app.js room controller without importing any DOM or bridge code.

export interface Room {
  roomId: string;
  name: string;
  description: string;
  memberAgentIds: string[];
  discussionCount: number;
  activeTopic?: string;
  [key: string]: unknown;
}

export interface DiscussionTurn {
  turnIndex: number;
  memberName: string;
  memberRole: string;
  content: string;
}

export interface DiscussionResult {
  roomId: string;
  consensus: string;
  turns: DiscussionTurn[];
  [key: string]: unknown;
}

export interface CreateRoomInput {
  name: string;
  description: string;
  memberAgentIds: string[];
}

export interface RoomCardView {
  roomId: string;
  title: string;
  memberLabel: string;
  description: string;
  discussionLabel: string;
  activeTopicLabel: string | null;
  activeTopicTitle: string | null;
}

/** Legacy parity: a room needs a name and at least one member persona. */
export function validateCreateRoomInput(input: CreateRoomInput): string | null {
  if (!input.name.trim() || input.memberAgentIds.length === 0) {
    return "Please provide a room name and select at least one member agent.";
  }
  return null;
}

export function formatRoomCard(room: Room): RoomCardView {
  const topic = typeof room.activeTopic === "string" && room.activeTopic.trim() ? room.activeTopic : null;
  return {
    roomId: room.roomId,
    title: room.name || "Untitled room",
    memberLabel: `${(room.memberAgentIds || []).length} Agents`,
    description: room.description || "No description.",
    discussionLabel: `Discussions: ${room.discussionCount || 0}`,
    activeTopicLabel: topic ? `Active Topic: ${topic.slice(0, 28)}...` : null,
    activeTopicTitle: topic,
  };
}

export interface RoomsModalState {
  createRoomModalOpen: boolean;
  conveneModalOpen: boolean;
  activeRoomId: string | null;
}

export function createInitialModalState(): RoomsModalState {
  return { createRoomModalOpen: false, conveneModalOpen: false, activeRoomId: null };
}

export function openCreateRoomModal(state: RoomsModalState): RoomsModalState {
  return { ...state, createRoomModalOpen: true };
}

export function closeCreateRoomModal(state: RoomsModalState): RoomsModalState {
  return { ...state, createRoomModalOpen: false };
}

export function openConveneModal(state: RoomsModalState, roomId: string): RoomsModalState {
  return { ...state, conveneModalOpen: true, activeRoomId: roomId };
}

export function closeConveneModal(state: RoomsModalState): RoomsModalState {
  return { ...state, conveneModalOpen: false, activeRoomId: null };
}

/** Accumulates turns so callers can append streaming rounds without losing earlier ones. */
export function appendTurns(existing: DiscussionTurn[], incoming: DiscussionTurn[] = []): DiscussionTurn[] {
  return [...existing, ...(Array.isArray(incoming) ? incoming : [])];
}

export function formatConsensus(result: DiscussionResult): string {
  return typeof result.consensus === "string" && result.consensus.trim()
    ? result.consensus
    : "No consensus rendered.";
}
